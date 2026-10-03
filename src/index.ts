/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

import { DOMParser } from '@xmldom/xmldom';
import { unzipSync, strFromU8 } from 'fflate';

export interface Env {
	// Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
	bucket: R2Bucket;

	// Variables defined in the "Environment Variables" section of the Wrangler CLI or dashboard
	USERNAME: string;
	PASSWORD: string;
}

async function* listAll(bucket: R2Bucket, prefix: string, isRecursive: boolean = false) {
	let cursor: string | undefined = undefined;
	do {
		var r2_objects = await bucket.list({
			prefix: prefix,
			delimiter: isRecursive ? undefined : '/',
			cursor: cursor,
			// @ts-ignore https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2listoptions
			include: ['httpMetadata', 'customMetadata'],
		});

		for (let object of r2_objects.objects) {
			yield object;
		}

		if (r2_objects.truncated) {
			cursor = r2_objects.cursor;
		}
	} while (r2_objects.truncated);
}

type DavProperties = {
	creationdate: string | undefined;
	displayname: string | undefined;
	getcontentlanguage: string | undefined;
	getcontentlength: string | undefined;
	getcontenttype: string | undefined;
	getetag: string | undefined;
	getlastmodified: string | undefined;
	resourcetype: string;
	supportedlock: string;
	lockdiscovery: string;
};

type LockDetails = {
	token: string;
	owner: string | undefined;
	scope: 'exclusive' | 'shared';
	depth: '0' | 'infinity';
	timeout: string;
	expiresAt: number;
	root: string;
};

type DeadProperty = {
	namespaceURI: string;
	localName: string;
	prefix: string | null;
	valueXml: string;
};

type PropfindRequest =
	| {
			mode: 'allprop';
	  }
	| {
			mode: 'propname';
	  }
	| {
			mode: 'prop';
			properties: DeadProperty[];
	  };

type ProppatchOperation = {
	action: 'set' | 'remove';
	property: DeadProperty;
};

const DEFAULT_LOCK_TIMEOUT = 3600;
const MAX_LOCK_TIMEOUT = 365 * 24 * 60 * 60;
const VALID_LOCK_DEPTHS = ['0', 'infinity'] as const;
const LOCK_METADATA_KEYS = [
	'lock_token',
	'lock_owner',
	'lock_scope',
	'lock_depth',
	'lock_timeout',
	'lock_expires_at',
	'lock_root',
	'lock_records',
];
const INTERNAL_DELETE_FORWARD_HEADERS = ['If', 'Lock-Token'] as const;
const RAW_XML_DAV_PROPERTIES = new Set(['resourcetype', 'supportedlock', 'lockdiscovery']);
const DAV_NAMESPACE = 'DAV:';
const DEAD_PROPERTY_PREFIX = 'dead_property:';
const LOCK_RECORDS_METADATA_KEY = 'lock_records';

function escapeXml(value: string): string {
	return value
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&apos;');
}

function getResourceHref(key: string, isCollection: boolean): string {
	const encodeHrefPath = (href: string): string => {
		if (href === '/') {
			return '/';
		}
		return href
			.split('/')
			.map((segment, index) => (index === 0 ? segment : encodeURIComponent(segment)))
			.join('/');
	};

	if (key === '') {
		return '/';
	}
	return encodeHrefPath(`/${key + (isCollection ? '/' : '')}`);
}

function decodeResourcePath(pathname: string): string {
	let resourcePath = pathname.slice(1);
	resourcePath = resourcePath.endsWith('/') ? resourcePath.slice(0, -1) : resourcePath;
	if (resourcePath === '') {
		return '';
	}
	return resourcePath
		.split('/')
		.map((segment) => {
			try {
				return decodeURIComponent(segment);
			} catch {
				return segment;
			}
		})
		.join('/');
}

function getParentPath(resourcePath: string): string {
	let normalizedPath = resourcePath.endsWith('/') ? resourcePath.slice(0, -1) : resourcePath;
	return normalizedPath.split('/').slice(0, -1).join('/');
}

async function hasCollectionResource(bucket: R2Bucket, resourcePath: string): Promise<boolean> {
	if (resourcePath === '') {
		return true;
	}

	let resource = await bucket.head(resourcePath);
	if (resource !== null) {
		return resource.customMetadata?.resourcetype === '<collection />';
	}

	let descendants = await bucket.list({
		prefix: resourcePath + '/',
		limit: 1,
	});
	return descendants.objects.length > 0;
}

function parseDestinationPath(destinationHeader: string, requestUrl: string): string | null {
	try {
		let destinationUrl = new URL(destinationHeader, requestUrl);
		if (destinationUrl.origin !== new URL(requestUrl).origin) {
			return null;
		}
		return decodeResourcePath(destinationUrl.pathname);
	} catch {
		return null;
	}
}

function isSameOrDescendantPath(resourcePath: string, destinationPath: string): boolean {
	if (destinationPath === resourcePath) {
		return true;
	}
	if (resourcePath === '') {
		return destinationPath !== '';
	}
	return destinationPath.startsWith(`${resourcePath}/`);
}

function createdResponse(
	resourcePath: string,
	isCollection: boolean,
	body: BodyInit | null = '',
	headers: HeadersInit = {},
): Response {
	let responseHeaders = new Headers(headers);
	responseHeaders.set('Location', getResourceHref(resourcePath, isCollection));
	return new Response(body, {
		status: 201,
		headers: responseHeaders,
	});
}

function renderDavProperty(propName: string, value: string): string {
	let content = RAW_XML_DAV_PROPERTIES.has(propName) ? value : escapeXml(value);
	return `<${propName}>${content}</${propName}>`;
}

function serializeNodeChildren(node: Node): string {
	let xml = '';
	for (let child = node.firstChild; child !== null; child = child.nextSibling) {
		xml += child.toString();
	}
	return xml;
}

function getDeadPropertyKey(namespaceURI: string, localName: string): string {
	return `${DEAD_PROPERTY_PREFIX}${encodeURIComponent(namespaceURI)}:${encodeURIComponent(localName)}`;
}

function getDeadProperty(
	metadata: Record<string, string> | undefined,
	namespaceURI: string,
	localName: string,
): DeadProperty | null {
	let value = metadata?.[getDeadPropertyKey(namespaceURI, localName)];
	if (value === undefined) {
		return null;
	}
	return JSON.parse(value) as DeadProperty;
}

function getDeadProperties(metadata: Record<string, string> | undefined): DeadProperty[] {
	if (metadata === undefined) {
		return [];
	}
	return Object.entries(metadata)
		.filter(([key]) => key.startsWith(DEAD_PROPERTY_PREFIX))
		.map(([, value]) => JSON.parse(value) as DeadProperty);
}

function renderPropertyElement(property: DeadProperty): string {
	let qualifiedName = property.prefix ? `${property.prefix}:${property.localName}` : property.localName;
	let namespaceDeclaration =
		property.namespaceURI === ''
			? ' xmlns=""'
			: property.prefix
				? ` xmlns:${property.prefix}="${escapeXml(property.namespaceURI)}"`
				: ` xmlns="${escapeXml(property.namespaceURI)}"`;
	return `<${qualifiedName}${namespaceDeclaration}>${property.valueXml}</${qualifiedName}>`;
}

function renderEmptyPropertyElement(property: DeadProperty): string {
	let qualifiedName = property.prefix ? `${property.prefix}:${property.localName}` : property.localName;
	let namespaceDeclaration =
		property.namespaceURI === ''
			? ' xmlns=""'
			: property.prefix
				? ` xmlns:${property.prefix}="${escapeXml(property.namespaceURI)}"`
				: ` xmlns="${escapeXml(property.namespaceURI)}"`;
	return `<${qualifiedName}${namespaceDeclaration} />`;
}

function getElementProperty(element: Element): DeadProperty | null {
	if (element.prefix && (element.namespaceURI === null || element.namespaceURI === '')) {
		return null;
	}
	return {
		namespaceURI: element.namespaceURI ?? '',
		localName: element.localName,
		prefix: element.prefix,
		valueXml: serializeNodeChildren(element),
	};
}

function parseXmlDocument(body: string): Document | null {
	let errors: string[] = [];
	let document = new DOMParser({
		errorHandler: {
			warning: () => {},
			error: (message) => errors.push(message),
			fatalError: (message) => errors.push(message),
		},
	}).parseFromString(body, 'application/xml');
	if (errors.length > 0) {
		return null;
	}
	return document;
}

function getChildElements(element: Element): Element[] {
	let children: Element[] = [];
	for (let child = element.firstChild; child !== null; child = child.nextSibling) {
		if (child.nodeType === child.ELEMENT_NODE) {
			children.push(child as Element);
		}
	}
	return children;
}

function parsePropfindRequest(body: string): PropfindRequest | null {
	if (body.trim() === '') {
		return { mode: 'allprop' };
	}
	let document = parseXmlDocument(body);
	if (document === null || document.documentElement.localName.toLowerCase() !== 'propfind') {
		return null;
	}
	let propfindChildren = getChildElements(document.documentElement);
	if (propfindChildren.some((child) => child.localName.toLowerCase() === 'propname')) {
		return { mode: 'propname' };
	}
	let propElement = propfindChildren.find((child) => child.localName.toLowerCase() === 'prop');
	if (propElement !== undefined) {
		let properties = getChildElements(propElement).map(getElementProperty);
		if (properties.some((property) => property === null)) {
			return null;
		}
		return {
			mode: 'prop',
			properties: properties as DeadProperty[],
		};
	}
	if (propfindChildren.some((child) => child.localName.toLowerCase() === 'allprop')) {
		return { mode: 'allprop' };
	}
	return null;
}

function parseProppatchRequest(body: string): { operations: ProppatchOperation[] } | null {
	let document = parseXmlDocument(body);
	if (document === null || document.documentElement.localName.toLowerCase() !== 'propertyupdate') {
		return null;
	}
	let operations: ProppatchOperation[] = [];
	for (const actionElement of getChildElements(document.documentElement)) {
		let action = actionElement.localName.toLowerCase();
		if (action !== 'set' && action !== 'remove') {
			continue;
		}
		let propElement = getChildElements(actionElement).find((child) => child.localName.toLowerCase() === 'prop');
		if (propElement === undefined) {
			continue;
		}
		for (const propertyElement of getChildElements(propElement)) {
			let property = getElementProperty(propertyElement);
			if (property === null) {
				return null;
			}
			operations.push({ action, property });
		}
	}
	return { operations };
}

function getSupportedLock(): string {
	return [
		'<lockentry><lockscope><exclusive /></lockscope><locktype><write /></locktype></lockentry>',
		'<lockentry><lockscope><shared /></lockscope><locktype><write /></locktype></lockentry>',
	].join('');
}

function determineLockDepth(
	resourceType: string | undefined,
	depthHeader: (typeof VALID_LOCK_DEPTHS)[number] | null,
): '0' | 'infinity' {
	if (resourceType === '<collection />') {
		return depthHeader ?? 'infinity';
	}
	return depthHeader === 'infinity' ? 'infinity' : '0';
}

function normalizeLockToken(lockToken: string): string {
	return lockToken
		.trim()
		.replace(/^<|>$/g, '')
		.replace(/^(?:urn:uuid:|opaquelocktoken:)/, '');
}

function normalizeLockDetails(lockDetails: Partial<LockDetails> & Pick<LockDetails, 'token'>): LockDetails | null {
	let expiresAt = Number(lockDetails.expiresAt ?? 0);
	if (!Number.isFinite(expiresAt) || expiresAt <= 0) {
		expiresAt = Date.now() + DEFAULT_LOCK_TIMEOUT * 1000;
	}
	if (expiresAt <= Date.now()) {
		return null;
	}

	return {
		token: lockDetails.token,
		owner: lockDetails.owner,
		scope: lockDetails.scope === 'shared' ? 'shared' : 'exclusive',
		depth: lockDetails.depth === 'infinity' ? 'infinity' : '0',
		timeout: lockDetails.timeout ?? `Second-${DEFAULT_LOCK_TIMEOUT}`,
		expiresAt,
		root: lockDetails.root ?? '/',
	};
}

function getLockDetails(customMetadata: Record<string, string> | undefined): LockDetails[] {
	let records = customMetadata?.[LOCK_RECORDS_METADATA_KEY];
	if (records !== undefined) {
		try {
			let parsed = JSON.parse(records);
			if (Array.isArray(parsed)) {
				return parsed.flatMap((lockDetails) => {
					if (lockDetails && typeof lockDetails === 'object' && typeof lockDetails.token === 'string') {
						let normalized = normalizeLockDetails(lockDetails as Partial<LockDetails> & Pick<LockDetails, 'token'>);
						return normalized === null ? [] : [normalized];
					}
					return [];
				});
			}
		} catch {}
	}

	let token = customMetadata?.lock_token;
	if (token === undefined) {
		return [];
	}

	let normalized = normalizeLockDetails({
		token,
		owner: customMetadata?.lock_owner,
		scope: customMetadata?.lock_scope === 'shared' ? 'shared' : 'exclusive',
		depth: customMetadata?.lock_depth === 'infinity' ? 'infinity' : '0',
		timeout: customMetadata?.lock_timeout ?? `Second-${DEFAULT_LOCK_TIMEOUT}`,
		expiresAt: Number(customMetadata?.lock_expires_at ?? 0),
		root: customMetadata?.lock_root ?? '/',
	});
	return normalized === null ? [] : [normalized];
}

function getLockDiscovery(lockDetails: LockDetails | LockDetails[]): string {
	let lockDetailList = Array.isArray(lockDetails) ? lockDetails : [lockDetails];
	return lockDetailList
		.map(
			(lockDetail) =>
				`<activelock><locktype><write /></locktype><lockscope><${lockDetail.scope} /></lockscope><depth>${lockDetail.depth}</depth>${lockDetail.owner ? `<owner>${escapeXml(lockDetail.owner)}</owner>` : ''}<timeout>${escapeXml(lockDetail.timeout)}</timeout><locktoken><href>urn:uuid:${escapeXml(lockDetail.token)}</href></locktoken><lockroot><href>${escapeXml(lockDetail.root)}</href></lockroot></activelock>`,
		)
		.join('');
}

function stripLockMetadata(customMetadata: Record<string, string> | undefined): Record<string, string> {
	let metadata = customMetadata ? { ...customMetadata } : {};
	for (const key of LOCK_METADATA_KEYS) {
		delete metadata[key];
	}
	return metadata;
}

function withLockMetadata(
	customMetadata: Record<string, string> | undefined,
	lockDetails: LockDetails | LockDetails[],
): Record<string, string> {
	let lockDetailList = Array.isArray(lockDetails) ? lockDetails : [lockDetails];
	if (lockDetailList.length === 0) {
		return stripLockMetadata(customMetadata);
	}
	return {
		...stripLockMetadata(customMetadata),
		[LOCK_RECORDS_METADATA_KEY]: JSON.stringify(lockDetailList),
	};
}

function getPreservedCustomMetadata(customMetadata: Record<string, string> | undefined): Record<string, string> {
	let lockDetails = getLockDetails(customMetadata);
	if (lockDetails.length === 0) {
		return stripLockMetadata(customMetadata);
	}
	return withLockMetadata(customMetadata, lockDetails);
}

function isProtectedProperty(propName: string | DeadProperty): boolean {
	let localPropName = typeof propName === 'string' ? (propName.split(':').pop() ?? propName) : propName.localName;
	return (
		LOCK_METADATA_KEYS.includes(localPropName) || localPropName === 'supportedlock' || localPropName === 'lockdiscovery'
	);
}

function isValidXmlTagName(propName: string): boolean {
	return /^[A-Za-z_][A-Za-z0-9._:-]*$/.test(propName);
}

function parseTimeout(timeoutHeader: string | null): { timeout: string; expiresAt: number } {
	if (timeoutHeader === null) {
		return {
			timeout: `Second-${DEFAULT_LOCK_TIMEOUT}`,
			expiresAt: Date.now() + DEFAULT_LOCK_TIMEOUT * 1000,
		};
	}

	for (const item of timeoutHeader.split(',').map((value) => value.trim())) {
		if (item.toLowerCase() === 'infinite') {
			return {
				timeout: 'Infinite',
				expiresAt: Date.now() + MAX_LOCK_TIMEOUT * 1000,
			};
		}

		let seconds = Number(item.match(/^Second-(\d+)$/i)?.[1] ?? NaN);
		if (Number.isFinite(seconds) && seconds > 0) {
			seconds = Math.min(seconds, MAX_LOCK_TIMEOUT);
			return {
				timeout: `Second-${seconds}`,
				expiresAt: Date.now() + seconds * 1000,
			};
		}
	}

	return {
		timeout: `Second-${DEFAULT_LOCK_TIMEOUT}`,
		expiresAt: Date.now() + DEFAULT_LOCK_TIMEOUT * 1000,
	};
}

function getRequestLockTokens(request: Request): string[] {
	let lockTokens: string[] = [];
	let directLockToken = request.headers.get('Lock-Token');
	if (directLockToken) {
		lockTokens.push(normalizeLockToken(directLockToken));
	}

	let ifHeader = request.headers.get('If');
	if (ifHeader) {
		for (const match of ifHeader.matchAll(/<([^>]+)>/g)) {
			let token = normalizeLockToken(match[1]);
			if (token !== '') {
				lockTokens.push(token);
			}
		}
	}

	return [...new Set(lockTokens)];
}

function hasAlwaysFalseIfCondition(request: Request): boolean {
	let ifHeader = request.headers.get('If') ?? '';
	return ifHeader.includes('<DAV:no-lock>') && !ifHeader.includes('Not <DAV:no-lock>');
}

function timingSafeEqual(left: Uint8Array, right: Uint8Array): boolean {
	if (left.byteLength !== right.byteLength) {
		return false;
	}
	let mismatch = 0;
	for (let index = 0; index < left.byteLength; index++) {
		mismatch |= left[index] ^ right[index];
	}
	return mismatch === 0;
}

function extractLockOwner(body: string): string | undefined {
	let owner = body.match(/<owner(?:\s[^>]*)?>([\s\S]*?)<\/owner>/i)?.[1];
	if (owner === undefined) {
		return undefined;
	}

	owner = owner.trim();
	return owner === '' ? undefined : owner;
}

function fromR2Object(object: R2Object | null | undefined): DavProperties {
	if (object === null || object === undefined) {
		return {
			creationdate: new Date().toUTCString(),
			displayname: undefined,
			getcontentlanguage: undefined,
			getcontentlength: '0',
			getcontenttype: undefined,
			getetag: undefined,
			getlastmodified: new Date().toUTCString(),
			resourcetype: '<collection />',
			supportedlock: getSupportedLock(),
			lockdiscovery: '',
		};
	}

	let isCollection = object.customMetadata?.resourcetype === '<collection />';
	let lockDetails = getLockDetails(object.customMetadata);
	return {
		creationdate: object.uploaded.toUTCString(),
		displayname: object.httpMetadata?.contentDisposition,
		getcontentlanguage: object.httpMetadata?.contentLanguage,
		getcontentlength: object.size.toString(),
		getcontenttype: object.httpMetadata?.contentType,
		getetag: object.etag,
		getlastmodified: object.uploaded.toUTCString(),
		resourcetype: object.customMetadata?.resourcetype ?? '',
		supportedlock: getSupportedLock(),
		lockdiscovery:
			lockDetails.length === 0
				? ''
				: getLockDiscovery(
						lockDetails.map((lockDetail) => ({
							...lockDetail,
							root: getResourceHref(object.key, isCollection),
						})),
					),
	};
}

function getLivePropertyValue(object: R2Object | null, property: DeadProperty): string | undefined {
	if (property.namespaceURI !== DAV_NAMESPACE) {
		return undefined;
	}
	return fromR2Object(object)[property.localName as keyof DavProperties];
}

function renderPropstat(status: string, properties: string[]): string {
	if (properties.length === 0) {
		return '';
	}
	return `
		<propstat>
			<prop>
			${properties.join('\n				')}
			</prop>
			<status>${status}</status>
		</propstat>`;
}

function make_resource_path(request: Request): string {
	return decodeResourcePath(new URL(request.url).pathname);
}

async function assertLockPermission(
	request: Request,
	bucket: R2Bucket,
	resourcePath: string,
	options: { ignoreSharedLocksOnTarget?: boolean } = {},
): Promise<Response | null> {
	if (hasAlwaysFalseIfCondition(request)) {
		return new Response('Precondition Failed', { status: 412 });
	}
	let lockTokens = getRequestLockTokens(request);
	let candidates: string[] = [];

	for (let current = resourcePath; current !== ''; current = current.split('/').slice(0, -1).join('/')) {
		candidates.push(current);
	}

	for (const candidate of candidates) {
		let object = await bucket.head(candidate);
		let lockDetails = getLockDetails(object?.customMetadata).filter(
			(lockDetail) =>
				(candidate === resourcePath || lockDetail.depth === 'infinity') &&
				!(options.ignoreSharedLocksOnTarget && candidate === resourcePath && lockDetail.scope === 'shared'),
		);
		if (lockDetails.length === 0) {
			continue;
		}

		if (!lockDetails.some((lockDetail) => lockTokens.includes(lockDetail.token))) {
			return new Response('Locked', { status: 423 });
		}
	}

	return null;
}

async function assertRecursiveDeletePermission(
	request: Request,
	bucket: R2Bucket,
	resourcePath: string,
): Promise<Response | null> {
	let lockResponse = await assertLockPermission(request, bucket, resourcePath);
	if (lockResponse !== null) {
		return lockResponse;
	}

	let lockTokens = getRequestLockTokens(request);
	let prefix = resourcePath === '' ? '' : resourcePath + '/';
	for await (let descendant of listAll(bucket, prefix, true)) {
		let lockDetails = getLockDetails(descendant.customMetadata);
		if (lockDetails.length > 0 && !lockDetails.some((lockDetail) => lockTokens.includes(lockDetail.token))) {
			return new Response('Locked', { status: 423 });
		}
	}

	return null;
}

async function findMatchingLock(
	request: Request,
	bucket: R2Bucket,
	resourcePath: string,
): Promise<{ resource: R2Object; lockDetails: LockDetails } | null> {
	let lockTokens = getRequestLockTokens(request);
	for (let current = resourcePath; ; current = current.split('/').slice(0, -1).join('/')) {
		let resource = await bucket.head(current);
		let lockDetails = getLockDetails(resource?.customMetadata).find(
			(lockDetail) =>
				lockTokens.includes(lockDetail.token) && (current === resourcePath || lockDetail.depth === 'infinity'),
		);
		if (resource !== null && lockDetails !== undefined) {
			return { resource, lockDetails };
		}
		if (current === '') {
			break;
		}
	}
	return null;
}

async function handle_head(request: Request, bucket: R2Bucket): Promise<Response> {
	let response = await handle_get(request, bucket);
	return new Response(null, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

function extractEpubMetadata(data: Uint8Array): { title?: string; author?: string; description?: string } {
	try {
		const unzipped = unzipSync(data, {
			filter: (file) => file.name === 'META-INF/container.xml' || file.name.endsWith('.opf'),
		});

		let opfPath = '';
		if (unzipped['META-INF/container.xml']) {
			const containerXml = strFromU8(unzipped['META-INF/container.xml']);
			const match = containerXml.match(/full-path\s*=\s*["']([^"']+)["']/i);
			if (match) {
				opfPath = match[1];
			}
		}

		let opfData: Uint8Array | undefined = undefined;
		if (opfPath && unzipped[opfPath]) {
			opfData = unzipped[opfPath];
		} else {
			const opfKey = Object.keys(unzipped).find((k) => k.endsWith('.opf'));
			if (opfKey) {
				opfData = unzipped[opfKey];
			}
		}

		if (!opfData) {
			return {};
		}

		const opfText = strFromU8(opfData);
		const titleMatch = opfText.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i);
		const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : undefined;

		const authorMatch = opfText.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i);
		const author = authorMatch ? authorMatch[1].replace(/<[^>]+>/g, '').trim() : undefined;

		const descMatch = opfText.match(/<dc:description[^>]*>([\s\S]*?)<\/dc:description>/i);
		const description = descMatch ? descMatch[1].replace(/<[^>]+>/g, '').trim() : undefined;

		return { title, author, description };
	} catch {
		return {};
	}
}

function extractMobiMetadata(data: Uint8Array): { title?: string; author?: string; description?: string } {
	try {
		if (data.length < 96) {
			return {};
		}
		const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
		const numRecords = view.getUint16(76);
		if (numRecords < 1) {
			return {};
		}
		const rec0Offset = view.getUint32(78);
		if (rec0Offset + 32 > data.length) {
			return {};
		}

		let mobiHeaderOffset = -1;
		for (let i = rec0Offset; i < Math.min(rec0Offset + 128, data.length - 8); i++) {
			if (data[i] === 0x4d && data[i + 1] === 0x4f && data[i + 2] === 0x42 && data[i + 3] === 0x49) {
				mobiHeaderOffset = i;
				break;
			}
		}
		if (mobiHeaderOffset === -1) {
			return {};
		}

		const mobiHeaderLen = view.getUint32(mobiHeaderOffset + 20);
		const fullNameOffset = view.getUint32(mobiHeaderOffset + 84);
		const fullNameLen = view.getUint32(mobiHeaderOffset + 88);

		let title: string | undefined = undefined;
		if (fullNameOffset && fullNameLen && rec0Offset + fullNameOffset + fullNameLen <= data.length) {
			const titleBytes = data.slice(rec0Offset + fullNameOffset, rec0Offset + fullNameOffset + fullNameLen);
			title = new TextDecoder().decode(titleBytes).trim();
		}

		let author: string | undefined = undefined;
		let description: string | undefined = undefined;
		const exthOffset = mobiHeaderOffset + mobiHeaderLen;

		if (
			exthOffset + 12 <= data.length &&
			data[exthOffset] === 0x45 &&
			data[exthOffset + 1] === 0x58 &&
			data[exthOffset + 2] === 0x54 &&
			data[exthOffset + 3] === 0x48
		) {
			const recCount = view.getUint32(exthOffset + 8);
			let curr = exthOffset + 12;
			for (let r = 0; r < recCount && curr + 8 <= data.length; r++) {
				const recType = view.getUint32(curr);
				const recLen = view.getUint32(curr + 4);
				if (recLen < 8 || curr + recLen > data.length) {
					break;
				}
				const recData = data.slice(curr + 8, curr + recLen);
				const text = new TextDecoder().decode(recData).trim();
				if (recType === 100 && !author) {
					author = text;
				} else if (recType === 103 && !description) {
					description = text;
				} else if (recType === 503 && text) {
					title = text;
				}
				curr += recLen;
			}
		}

		return { title, author, description };
	} catch {
		return {};
	}
}

function isSupportedEbook(key: string): boolean {
	const lower = key.toLowerCase();
	return (
		lower.endsWith('.epub') ||
		lower.endsWith('.mobi') ||
		lower.endsWith('.azw3') ||
		lower.endsWith('.azw') ||
		lower.endsWith('.prc')
	);
}

function extractBookMetadata(key: string, data: Uint8Array): { title?: string; author?: string; description?: string } {
	const lower = key.toLowerCase();
	if (lower.endsWith('.epub')) {
		return extractEpubMetadata(data);
	}
	if (lower.endsWith('.mobi') || lower.endsWith('.azw3') || lower.endsWith('.azw') || lower.endsWith('.prc')) {
		return extractMobiMetadata(data);
	}
	return {};
}

function getBookMimeType(key: string): string {
	const lower = key.toLowerCase();
	if (lower.endsWith('.epub')) return 'application/epub+zip';
	if (lower.endsWith('.mobi') || lower.endsWith('.prc')) return 'application/x-mobipocket-ebook';
	if (lower.endsWith('.azw3') || lower.endsWith('.azw')) return 'application/vnd.amazon.ebook';
	return 'application/octet-stream';
}

function isBookFile(key: string): boolean {
	const lower = key.toLowerCase();
	return (
		lower.endsWith('.epub') ||
		lower.endsWith('.mobi') ||
		lower.endsWith('.azw3') ||
		lower.endsWith('.azw') ||
		lower.endsWith('.prc')
	);
}

function parseBookMeta(key: string): { title: string; author: string } {
	const filename = key.split('/').pop() ?? key;
	const nameWithoutExt = filename.replace(/\.[^/.]+$/, '');
	if (nameWithoutExt.includes(' - ')) {
		const parts = nameWithoutExt.split(' - ');
		return { author: parts[0].trim(), title: parts.slice(1).join(' - ').trim() };
	}
	const dirParts = key.split('/');
	if (dirParts.length >= 2) {
		return { author: dirParts[dirParts.length - 2].trim(), title: nameWithoutExt.trim() };
	}
	return { author: 'Unknown Author', title: nameWithoutExt.trim() };
}

async function handle_opds(request: Request, bucket: R2Bucket): Promise<Response> {
	const url = new URL(request.url);
	const origin = url.origin;
	const searchQuery = url.searchParams.get('q')?.toLowerCase();

	let entries: string[] = [];
	for await (const object of listAll(bucket, '', true)) {
		if (
			object.key.endsWith('/') ||
			object.key.split('/').some((part) => part.startsWith('.') || part.startsWith('._'))
		) {
			continue;
		}

		if (!isBookFile(object.key)) {
			continue;
		}

		let title = object.customMetadata?.book_title;
		let author = object.customMetadata?.book_author;
		let description = object.customMetadata?.book_description;

		if ((!title || !author) && isSupportedEbook(object.key)) {
			try {
				let bookObj = await bucket.get(object.key);
				if (bookObj && 'body' in bookObj) {
					let buf = await bookObj.arrayBuffer();
					let meta = extractBookMetadata(object.key, new Uint8Array(buf));
					if (meta.title) title = meta.title;
					if (meta.author) author = meta.author;
					if (meta.description) description = meta.description;

					let updatedMeta = { ...(object.customMetadata ?? {}) };
					if (title) updatedMeta.book_title = title;
					if (author) updatedMeta.book_author = author;
					if (description) updatedMeta.book_description = description;

					await bucket.put(object.key, buf, {
						httpMetadata: object.httpMetadata,
						customMetadata: updatedMeta,
					});
				}
			} catch {}
		}

		if (!title || !author) {
			const fallback = parseBookMeta(object.key);
			title = title ?? fallback.title;
			author = author ?? fallback.author;
		}

		if (searchQuery) {
			const haystack = `${title} ${author} ${object.key}`.toLowerCase();
			if (!haystack.includes(searchQuery)) {
				continue;
			}
		}

		const mimeType = getBookMimeType(object.key);
		const downloadUrl = `${origin}${getResourceHref(object.key, false)}`;
		const updatedIso = object.uploaded ? new Date(object.uploaded).toISOString() : new Date().toISOString();
		const bookId = `urn:r2:${encodeURIComponent(object.key)}`;
		const sizeFormatted = `${(object.size / (1024 * 1024)).toFixed(2)} MB`;
		const summaryText = description
			? `${escapeXml(description)} (${sizeFormatted})`
			: `${escapeXml(title)} by ${escapeXml(author)} (${sizeFormatted})`;

		entries.push(`  <entry>
    <title>${escapeXml(title)}</title>
    <id>${escapeXml(bookId)}</id>
    <updated>${updatedIso}</updated>
    <author>
      <name>${escapeXml(author)}</name>
    </author>
    <summary>${summaryText}</summary>
    <link rel="http://opds-spec.org/acquisition" href="${escapeXml(downloadUrl)}" type="${mimeType}"/>
  </entry>`);
	}

	const feedXml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"
      xmlns:dc="http://purl.org/dc/terms/"
      xmlns:opds="http://opds-spec.org/2010/catalog">
  <id>urn:uuid:cloudflare-r2-opds-catalog</id>
  <title>Cloud E-Book Library</title>
  <updated>${new Date().toISOString()}</updated>
  <icon>/favicon.ico</icon>
  <author>
    <name>My Cloud Library</name>
  </author>
  <link rel="self" href="${origin}/opds" type="application/atom+xml;profile=opds-catalog"/>
  <link rel="start" href="${origin}/opds" type="application/atom+xml;profile=opds-catalog"/>
  <link rel="search" href="${origin}/opds?q={searchTerms}" type="application/atom+xml;profile=opds-catalog"/>
${entries.join('\n')}
</feed>`;

	return new Response(feedXml, {
		status: 200,
		headers: {
			'Content-Type': 'application/atom+xml;profile=opds-catalog;charset=utf-8',
			'Cache-Control': 'no-cache',
		},
	});
}

async function handle_get(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);

	if (resource_path === 'opds') {
		return await handle_opds(request, bucket);
	}

	if (request.url.endsWith('/')) {
		if (resource_path !== '') {
			let resource = await bucket.head(resource_path);
			if (resource === null || resource.customMetadata?.resourcetype !== '<collection />') {
				return new Response('Not Found', { status: 404 });
			}
		}

		function formatBytes(bytes: number): string {
			if (bytes === 0) return '0 B';
			const k = 1024;
			const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
			const i = Math.floor(Math.log(bytes) / Math.log(k));
			return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
		}

		const folderIcon = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:8px;display:inline-block;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`;
		const parentFolderIcon = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:8px;display:inline-block;"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path><polyline points="9 14 12 11 15 14"></polyline></svg>`;
		const fileIcon = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:8px;display:inline-block;"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline></svg>`;

		let rows = '',
			prefix = resource_path;
		if (resource_path !== '') {
			rows += `<tr>
				<td class="name-cell"><a href="../" class="item-link">${parentFolderIcon}..</a></td>
				<td class="meta-cell hide-mobile">-</td>
				<td class="meta-cell hide-mobile">-</td>
				<td class="actions-cell"></td>
			</tr>`;
			prefix = `${resource_path}/`;
		}

		for await (const object of listAll(bucket, prefix)) {
			if (object.key === resource_path) {
				continue;
			}
			let isCollection = object.customMetadata?.resourcetype === '<collection />';
			let href = getResourceHref(object.key, isCollection);
			let displayName = object.httpMetadata?.contentDisposition ?? object.key.slice(prefix.length);
			let bookTitle = object.customMetadata?.book_title;
			let bookAuthor = object.customMetadata?.book_author;
			let labelText = bookTitle ? (bookAuthor ? `${bookTitle} — ${bookAuthor}` : bookTitle) : displayName;
			let sizeFormatted = isCollection ? '-' : formatBytes(object.size);
			let dateFormatted = object.uploaded
				? new Date(object.uploaded).toISOString().replace('T', ' ').substring(0, 19)
				: '-';
			let downloadAction = isCollection
				? ''
				: `<a href="${escapeXml(href)}" download class="btn btn-secondary">Download</a>`;
			let deleteAction = `<button type="button" class="btn btn-danger" onclick="deleteItem('${escapeXml(
				href,
			)}', '${escapeXml(displayName)}')">Delete</button>`;

			let itemIcon = isCollection ? folderIcon : fileIcon;

			rows += `<tr>
				<td class="name-cell">
					<a href="${escapeXml(href)}" class="item-link">${itemIcon}${escapeXml(labelText)}</a>
					<div class="mobile-meta">${sizeFormatted} &bull; ${dateFormatted}</div>
				</td>
				<td class="meta-cell hide-mobile">${sizeFormatted}</td>
				<td class="meta-cell hide-mobile">${dateFormatted}</td>
				<td class="actions-cell">${downloadAction}${deleteAction}</td>
			</tr>`;
		}

		var pageSource = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,viewport-fit=cover">
<title>R2 Storage</title>
<style>
:root{--bg:#0f172a;--card-bg:#1e293b;--text:#f8fafc;--text-muted:#94a3b8;--border:#334155;--primary:#38bdf8;--primary-hover:#0284c7;--danger:#ef4444;--table-hover:#263349;}
*{box-sizing:border-box;margin:0;padding:0;}
body{background-color:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;padding:24px;max-width:1100px;margin:0 auto;line-height:1.5;}
header{margin-bottom:20px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;}
h1{font-size:1.5rem;font-weight:600;color:#fff;}
.path-bar{background:var(--card-bg);padding:10px 16px;border-radius:6px;border:1px solid var(--border);margin-bottom:16px;font-size:0.95rem;color:var(--text-muted);}
.path-bar span{color:var(--primary);font-weight:500;}
.actions-bar{display:flex;gap:10px;flex-wrap:wrap;}
.btn{display:inline-flex;align-items:center;justify-content:center;padding:7px 14px;font-size:0.875rem;font-weight:500;border-radius:6px;border:1px solid transparent;cursor:pointer;text-decoration:none;transition:all 0.15s;}
.btn-primary{background:var(--primary);color:#0f172a;}
.btn-primary:hover{background:var(--primary-hover);color:#fff;}
.btn-secondary{background:var(--card-bg);color:var(--text);border-color:var(--border);}
.btn-secondary:hover{background:var(--border);}
.btn-danger{background:transparent;color:var(--danger);border-color:rgba(239,68,68,0.4);margin-left:8px;}
.btn-danger:hover{background:var(--danger);color:#fff;}
.drop-zone{border:2px dashed var(--border);border-radius:8px;padding:28px 20px;text-align:center;background:rgba(30,41,59,0.5);margin-bottom:20px;cursor:pointer;transition:border-color 0.2s,background-color 0.2s;}
.drop-zone.dragover{border-color:var(--primary);background:rgba(56,189,248,0.1);}
.drop-zone p{color:var(--text-muted);font-size:0.95rem;}
.drop-zone .hint{font-size:0.8rem;margin-top:6px;color:#64748b;}
#progress-container{display:none;background:var(--card-bg);border:1px solid var(--border);border-radius:6px;padding:14px;margin-bottom:16px;}
.progress-info{font-size:0.875rem;margin-bottom:8px;display:flex;justify-content:space-between;}
.progress-track{background:#0f172a;border-radius:4px;height:8px;overflow:hidden;}
.progress-fill{background:var(--primary);height:100%;width:0%;transition:width 0.2s;}
.table-container{background:var(--card-bg);border:1px solid var(--border);border-radius:8px;overflow:hidden;}
table{width:100%;border-collapse:collapse;font-size:0.875rem;}
th{text-align:left;padding:12px 16px;background:rgba(15,23,42,0.6);color:var(--text-muted);font-weight:500;border-bottom:1px solid var(--border);}
td{padding:12px 16px;border-bottom:1px solid var(--border);vertical-align:middle;}
tr:last-child td{border-bottom:none;}
tr:hover td{background-color:var(--table-hover);}
.name-cell a{color:var(--text);text-decoration:none;font-weight:500;}
.name-cell a:hover{color:var(--primary);}
.meta-cell{color:var(--text-muted);white-space:nowrap;}
.actions-cell{text-align:right;white-space:nowrap;}
.empty-state{padding:40px;text-align:center;color:var(--text-muted);}
.mobile-meta{display:none;}
.desktop-hint{display:block;}
.mobile-hint{display:none;}
@media (max-width:640px){
body{padding:14px 10px;}
h1{font-size:1.25rem;}
header{flex-direction:column;align-items:stretch;gap:10px;margin-bottom:14px;}
.actions-bar{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
.actions-bar a.btn-secondary{grid-column:span 2;text-align:center;justify-content:center;}
.btn{min-height:42px;padding:8px 12px;font-size:0.875rem;}
.path-bar{padding:8px 12px;font-size:0.85rem;word-break:break-all;margin-bottom:12px;}
.drop-zone{padding:20px 12px;margin-bottom:16px;}
.desktop-hint{display:none !important;}
.mobile-hint{display:block !important;}
.hide-mobile{display:none !important;}
.mobile-meta{display:block;font-size:0.75rem;color:var(--text-muted);margin-top:4px;}
th,td{padding:10px 8px;}
.name-cell{word-break:break-word;}
.actions-cell .btn{min-height:34px;padding:6px 10px;font-size:0.8rem;margin-left:4px;}
}
</style>
</head>
<body>
<header>
<h1>R2 Storage</h1>
<div class="actions-bar">
<button type="button" class="btn btn-primary" onclick="document.getElementById('file-input').click()">Upload Files</button>
<button type="button" class="btn btn-secondary" onclick="createFolder()">New Folder</button>
<a href="/opds" target="_blank" class="btn btn-secondary">KOReader OPDS Feed</a>
<input type="file" id="file-input" multiple style="display:none" onchange="handleFiles(this.files)">
</div>
</header>
<div class="path-bar">Current Directory: <span>/${escapeXml(resource_path)}</span></div>
<div class="drop-zone" id="drop-zone" onclick="document.getElementById('file-input').click()">
<p class="desktop-hint">Drag and drop files here, or click to browse</p>
<p class="mobile-hint">Tap here to choose files to upload</p>
<div class="hint">Upload limit: 100 MB per file (Cloudflare Free Tier limit)</div>
</div>
<div id="progress-container">
<div class="progress-info">
<span id="progress-status">Uploading...</span>
<span id="progress-percentage">0%</span>
</div>
<div class="progress-track">
<div class="progress-fill" id="progress-fill"></div>
</div>
</div>
<div class="table-container">
<table>
<thead>
<tr>
<th>Name</th>
<th class="hide-mobile">Size</th>
<th class="hide-mobile">Last Modified</th>
<th style="text-align:right;">Actions</th>
</tr>
</thead>
<tbody>
${rows || '<tr><td colspan="4" class="empty-state">No files in this directory. Drag and drop files above to upload.</td></tr>'}
</tbody>
</table>
</div>
<script>
const dropZone=document.getElementById('drop-zone');
dropZone.addEventListener('dragover',(e)=>{e.preventDefault();dropZone.classList.add('dragover');});
dropZone.addEventListener('dragleave',()=>dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop',(e)=>{
e.preventDefault();
dropZone.classList.remove('dragover');
if(e.dataTransfer&&e.dataTransfer.files){handleFiles(e.dataTransfer.files);}
});
async function handleFiles(files){
if(!files||files.length===0)return;
const progressContainer=document.getElementById('progress-container');
const status=document.getElementById('progress-status');
const percentage=document.getElementById('progress-percentage');
const fill=document.getElementById('progress-fill');
progressContainer.style.display='block';
for(let i=0;i<files.length;i++){
const file=files[i];
const pct=Math.round((i/files.length)*100);
status.textContent='Uploading ('+(i+1)+'/'+files.length+'): '+file.name;
percentage.textContent=pct+'%';
fill.style.width=pct+'%';
try{
const res=await fetch(encodeURIComponent(file.name),{
method:'PUT',
body:file,
headers:{'Content-Type':file.type||'application/octet-stream'}
});
if(!res.ok){alert('Upload failed for '+file.name+': '+res.statusText);return;}
}catch(err){alert('Upload error for '+file.name+': '+err.message);return;}
}
fill.style.width='100%';
percentage.textContent='100%';
status.textContent='Upload complete! Refreshing...';
setTimeout(()=>window.location.reload(),600);
}
async function deleteItem(href,name){
if(!confirm('Are you sure you want to delete "'+name+'"?'))return;
try{
const res=await fetch(href,{method:'DELETE'});
if(res.ok){window.location.reload();}else{alert('Failed to delete: '+res.statusText);}
}catch(err){alert('Error deleting: '+err.message);}
}
async function createFolder(){
const name=prompt('Enter new folder name:');
if(!name)return;
const clean=name.trim().replace(/\\/+$/,'');
if(!clean)return;
try{
const res=await fetch(encodeURIComponent(clean)+'/',{method:'MKCOL'});
if(res.ok){window.location.reload();}else{alert('Failed to create folder: '+res.statusText);}
}catch(err){alert('Error creating folder: '+err.message);}
}
</script>
</body>
</html>`;

		return new Response(pageSource, {
			status: 200,
			headers: { 'Content-Type': 'text/html; charset=utf-8' },
		});
	} else {
		let object = await bucket.get(resource_path, {
			onlyIf: request.headers,
			range: request.headers,
		});

		let isR2ObjectBody = (object: R2Object | R2ObjectBody): object is R2ObjectBody => {
			return 'body' in object;
		};

		if (object === null) {
			return new Response('Not Found', { status: 404 });
		} else if (!isR2ObjectBody(object)) {
			return new Response('Precondition Failed', { status: 412 });
		} else {
			const { rangeOffset, rangeEnd } = calcContentRange(object);
			const contentLength = rangeEnd - rangeOffset + 1;
			const rangeRequested = request.headers.has('Range') && object.range !== undefined;
			return new Response(object.body, {
				status: rangeRequested ? 206 : 200,
				headers: {
					'Accept-Ranges': 'bytes',
					'Content-Type': object.httpMetadata?.contentType ?? 'application/octet-stream',
					'Content-Length': contentLength.toString(),
					...(rangeRequested ? { 'Content-Range': `bytes ${rangeOffset}-${rangeEnd}/${object.size}` } : {}),
					...(object.httpMetadata?.contentDisposition
						? {
								'Content-Disposition': object.httpMetadata.contentDisposition,
							}
						: {}),
					...(object.httpMetadata?.contentEncoding
						? {
								'Content-Encoding': object.httpMetadata.contentEncoding,
							}
						: {}),
					...(object.httpMetadata?.contentLanguage
						? {
								'Content-Language': object.httpMetadata.contentLanguage,
							}
						: {}),
					...(object.httpMetadata?.cacheControl
						? {
								'Cache-Control': object.httpMetadata.cacheControl,
							}
						: {}),
					...(object.httpMetadata?.cacheExpiry
						? {
								'Cache-Expiry': object.httpMetadata.cacheExpiry.toISOString(),
							}
						: {}),
				},
			});
		}
	}
}

function calcContentRange(object: R2ObjectBody) {
	let rangeOffset = 0;
	let rangeEnd = object.size - 1;
	if (object.range) {
		if ('suffix' in object.range) {
			// Case 3: {suffix: number}
			rangeOffset = object.size - object.range.suffix;
		} else {
			// Case 1: {offset: number, length?: number}
			// Case 2: {offset?: number, length: number}
			rangeOffset = object.range.offset ?? 0;
			let length = object.range.length ?? object.size - rangeOffset;
			rangeEnd = Math.min(rangeOffset + length - 1, object.size - 1);
		}
	}
	return { rangeOffset, rangeEnd };
}

async function handle_put(request: Request, bucket: R2Bucket): Promise<Response> {
	if (request.url.endsWith('/')) {
		return new Response('Method Not Allowed', { status: 405 });
	}

	let resource_path = make_resource_path(request);
	let lockResponse = await assertLockPermission(request, bucket, resource_path);
	if (lockResponse !== null) {
		return lockResponse;
	}
	let existing = await bucket.head(resource_path);

	// Check if the parent directory exists
	let dirpath = getParentPath(resource_path);
	if (!(await hasCollectionResource(bucket, dirpath))) {
		return new Response('Conflict', { status: 409 });
	}

	let body = await request.arrayBuffer();
	let customMeta = getPreservedCustomMetadata(existing?.customMetadata);
	if (isBookFile(resource_path)) {
		let bookMeta = extractBookMetadata(resource_path, new Uint8Array(body));
		if (bookMeta.title) customMeta.book_title = bookMeta.title;
		if (bookMeta.author) customMeta.book_author = bookMeta.author;
		if (bookMeta.description) customMeta.book_description = bookMeta.description;
	}
	await bucket.put(resource_path, body, {
		onlyIf: request.headers,
		httpMetadata: request.headers,
		customMetadata: customMeta,
	});
	return existing === null ? new Response('', { status: 201 }) : new Response(null, { status: 204 });
}

async function handle_delete(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let lockResponse = await assertRecursiveDeletePermission(request, bucket, resource_path);
	if (lockResponse !== null) {
		return lockResponse;
	}

	if (resource_path === '') {
		let r2_objects,
			cursor: string | undefined = undefined;
		do {
			r2_objects = await bucket.list({ cursor: cursor });
			let keys = r2_objects.objects.map((object) => object.key);
			if (keys.length > 0) {
				await bucket.delete(keys);
			}

			if (r2_objects.truncated) {
				cursor = r2_objects.cursor;
			}
		} while (r2_objects.truncated);

		return new Response(null, { status: 204 });
	}

	let resource = await bucket.head(resource_path);
	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}
	if (resource.customMetadata?.resourcetype !== '<collection />') {
		await bucket.delete(resource_path);
		return new Response(null, { status: 204 });
	}

	let r2_objects,
		cursor: string | undefined = undefined;
	do {
		r2_objects = await bucket.list({
			prefix: resource_path + '/',
			cursor: cursor,
		});
		let keys = r2_objects.objects.map((object) => object.key);
		if (keys.length > 0) {
			await bucket.delete(keys);
		}

		if (r2_objects.truncated) {
			cursor = r2_objects.cursor;
		}
	} while (r2_objects.truncated);

	await bucket.delete(resource_path);
	return new Response(null, { status: 204 });
}

async function handle_mkcol(request: Request, bucket: R2Bucket): Promise<Response> {
	if ((await request.clone().arrayBuffer()).byteLength > 0) {
		return new Response('Unsupported Media Type', { status: 415 });
	}

	let resource_path = make_resource_path(request);
	let lockResponse = await assertLockPermission(request, bucket, resource_path);
	if (lockResponse !== null) {
		return lockResponse;
	}

	// Check if the resource already exists
	let resource = await bucket.head(resource_path);
	if (resource !== null) {
		return new Response('Method Not Allowed', { status: 405 });
	}

	// Check if the parent directory exists
	let parent_dir = getParentPath(resource_path);
	if (!(await hasCollectionResource(bucket, parent_dir))) {
		return new Response('Conflict', { status: 409 });
	}

	await bucket.put(resource_path, new Uint8Array(), {
		httpMetadata: request.headers,
		customMetadata: { resourcetype: '<collection />' },
	});
	return new Response('', { status: 201 });
}

function generate_propfind_response(object: R2Object | null, propfindRequest: PropfindRequest): string {
	let href =
		object === null ? '/' : getResourceHref(object.key, object.customMetadata?.resourcetype === '<collection />');
	let deadProperties = getDeadProperties(object?.customMetadata);
	let liveProperties = Object.entries(fromR2Object(object)).flatMap(([key, value]) =>
		value === undefined ? [] : [renderDavProperty(key, value)],
	);

	let okProperties: string[] = [];
	let missingProperties: string[] = [];

	switch (propfindRequest.mode) {
		case 'allprop': {
			okProperties = [...liveProperties, ...deadProperties.map(renderPropertyElement)];
			break;
		}
		case 'propname': {
			okProperties = [
				...Object.entries(fromR2Object(object)).flatMap(([key, value]) =>
					value === undefined ? [] : [renderDavProperty(key, '')],
				),
				...deadProperties.map((property) => renderEmptyPropertyElement({ ...property, valueXml: '' })),
			];
			break;
		}
		case 'prop': {
			for (const property of propfindRequest.properties) {
				let liveValue = getLivePropertyValue(object, property);
				if (liveValue !== undefined) {
					okProperties.push(renderDavProperty(property.localName, liveValue));
					continue;
				}
				let deadProperty = getDeadProperty(object?.customMetadata, property.namespaceURI, property.localName);
				if (deadProperty !== null) {
					okProperties.push(renderPropertyElement(deadProperty));
				} else {
					missingProperties.push(renderEmptyPropertyElement({ ...property, valueXml: '' }));
				}
			}
			break;
		}
	}

	return `
	<response>
		<href>${escapeXml(href)}</href>${renderPropstat('HTTP/1.1 200 OK', okProperties)}${renderPropstat('HTTP/1.1 404 Not Found', missingProperties)}
	</response>`;
}

async function handle_propfind(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let propfindRequest = parsePropfindRequest(await request.text());
	if (propfindRequest === null) {
		return new Response('Bad Request', { status: 400 });
	}

	let is_collection: boolean;
	let page = `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">`;

	if (resource_path === '') {
		page += generate_propfind_response(null, propfindRequest);
		is_collection = true;
	} else {
		let object = await bucket.head(resource_path);
		if (object === null) {
			return new Response('Not Found', { status: 404 });
		}
		is_collection = object.customMetadata?.resourcetype === '<collection />';
		page += generate_propfind_response(object, propfindRequest);
	}

	if (is_collection) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		switch (depth) {
			case '0':
				break;
			case '1':
				{
					let prefix = resource_path === '' ? resource_path : resource_path + '/';
					for await (let object of listAll(bucket, prefix)) {
						page += generate_propfind_response(object, propfindRequest);
					}
				}
				break;
			case 'infinity':
				{
					let prefix = resource_path === '' ? resource_path : resource_path + '/';
					for await (let object of listAll(bucket, prefix, true)) {
						page += generate_propfind_response(object, propfindRequest);
					}
				}
				break;
			default: {
				return new Response('Bad Request', { status: 400 });
			}
		}
	}

	page += '\n</multistatus>\n';
	return new Response(page, {
		status: 207,
		headers: {
			'Content-Type': 'application/xml; charset=utf-8',
		},
	});
}

async function handle_proppatch(request: Request, bucket: R2Bucket): Promise<Response> {
	const resource_path = make_resource_path(request);
	let lockResponse = await assertLockPermission(request, bucket, resource_path);
	if (lockResponse !== null) {
		return lockResponse;
	}

	// 检查资源是否存在
	let object = await bucket.head(resource_path);
	if (object === null) {
		return new Response('Not Found', { status: 404 });
	}

	const body = await request.text();
	let parsedRequest = parseProppatchRequest(body);
	if (parsedRequest === null) {
		return new Response('Bad Request', { status: 400 });
	}
	const { operations } = parsedRequest;

	// 复制原有的自定义元数据
	const customMetadata = getPreservedCustomMetadata(object.customMetadata);
	const successfulSetProperties: DeadProperty[] = [];
	const failedSetProperties: DeadProperty[] = [];
	const successfulRemoveProperties: DeadProperty[] = [];
	const failedRemoveProperties: DeadProperty[] = [];

	// 更新元数据
	for (const operation of operations) {
		if (isProtectedProperty(operation.property)) {
			if (operation.action === 'set') {
				failedSetProperties.push(operation.property);
			} else {
				failedRemoveProperties.push(operation.property);
			}
			continue;
		}
		if (operation.action === 'set') {
			customMetadata[getDeadPropertyKey(operation.property.namespaceURI, operation.property.localName)] =
				JSON.stringify(operation.property);
			successfulSetProperties.push(operation.property);
		} else {
			delete customMetadata[getDeadPropertyKey(operation.property.namespaceURI, operation.property.localName)];
			successfulRemoveProperties.push(operation.property);
		}
	}

	const hasFailures = failedSetProperties.length > 0 || failedRemoveProperties.length > 0;
	if (!hasFailures) {
		// 更新对象的元数据
		const src = await bucket.get(object.key);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}

		await bucket.put(object.key, src.body, {
			httpMetadata: object.httpMetadata,
			customMetadata: customMetadata,
		});
	}

	// 构造响应
	let propstats = new Map<string, string[]>();
	const appendPropstat = (property: DeadProperty, status: string) => {
		let props = propstats.get(status) ?? [];
		props.push(renderEmptyPropertyElement({ ...property, valueXml: '' }));
		propstats.set(status, props);
	};
	const successStatus = hasFailures ? 'HTTP/1.1 424 Failed Dependency' : 'HTTP/1.1 200 OK';

	for (const property of successfulSetProperties) {
		appendPropstat(property, successStatus);
	}

	for (const property of successfulRemoveProperties) {
		appendPropstat(property, successStatus);
	}

	for (const property of failedSetProperties) {
		appendPropstat(property, 'HTTP/1.1 403 Forbidden');
	}

	for (const property of failedRemoveProperties) {
		appendPropstat(property, 'HTTP/1.1 403 Forbidden');
	}

	let responseXML = `<?xml version="1.0" encoding="utf-8"?>\n<multistatus xmlns="DAV:">\n\t<response>\n\t\t<href>${escapeXml(getResourceHref(object.key, object.customMetadata?.resourcetype === '<collection />'))}</href>`;
	for (const [status, propNames] of propstats) {
		responseXML += `\n\t\t<propstat>\n\t\t\t<prop>\n${propNames.map((propName) => `\t\t\t\t${propName}`).join('\n')}\n\t\t\t</prop>\n\t\t\t<status>${status}</status>\n\t\t</propstat>`;
	}
	responseXML += '\n\t</response>\n</multistatus>';

	return new Response(responseXML, {
		status: 207,
		headers: {
			'Content-Type': 'application/xml; charset=utf-8',
		},
	});
}

async function handle_copy(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let dont_overwrite = request.headers.get('Overwrite') === 'F';
	let destination_header = request.headers.get('Destination');
	if (destination_header === null) {
		return new Response('Bad Request', { status: 400 });
	}
	let destination = parseDestinationPath(destination_header, request.url);
	if (destination === null) {
		return new Response('Bad Request', { status: 400 });
	}
	if (isSameOrDescendantPath(resource_path, destination)) {
		return new Response('Bad Request', { status: 400 });
	}
	let lockResponse = await assertLockPermission(request, bucket, destination);
	if (lockResponse !== null) {
		return lockResponse;
	}

	// Check if the parent directory exists
	let destination_parent = getParentPath(destination);
	if (!(await hasCollectionResource(bucket, destination_parent))) {
		return new Response('Conflict', { status: 409 });
	}

	// Check if the destination already exists
	let destination_exists = await bucket.head(destination);
	if (dont_overwrite && destination_exists) {
		return new Response('Precondition Failed', { status: 412 });
	}

	let resource = await bucket.head(resource_path);
	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}

	let is_dir = resource?.customMetadata?.resourcetype === '<collection />';

	if (is_dir) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		switch (depth) {
			case 'infinity': {
				let prefix = resource_path + '/';
				const copy = async (object: R2Object) => {
					let target = destination + '/' + object.key.slice(prefix.length);
					target = target.endsWith('/') ? target.slice(0, -1) : target;
					let src = await bucket.get(object.key);
					if (src !== null) {
						await bucket.put(target, src.body, {
							httpMetadata: object.httpMetadata,
							customMetadata: stripLockMetadata(object.customMetadata),
						});
					}
				};
				let promise_array = [copy(resource)];
				for await (let object of listAll(bucket, prefix, true)) {
					promise_array.push(copy(object));
				}
				await Promise.all(promise_array);
				if (destination_exists) {
					return new Response(null, { status: 204 });
				} else {
					return createdResponse(destination, true);
				}
			}
			case '0': {
				let object = await bucket.get(resource.key);
				if (object === null) {
					return new Response('Not Found', { status: 404 });
				}
				await bucket.put(destination, object.body, {
					httpMetadata: object.httpMetadata,
					customMetadata: stripLockMetadata(object.customMetadata),
				});
				if (destination_exists) {
					return new Response(null, { status: 204 });
				} else {
					return createdResponse(destination, true);
				}
			}
			default: {
				return new Response('Bad Request', { status: 400 });
			}
		}
	} else {
		let src = await bucket.get(resource.key);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}
		await bucket.put(destination, src.body, {
			httpMetadata: src.httpMetadata,
			customMetadata: stripLockMetadata(src.customMetadata),
		});
		if (destination_exists) {
			return new Response(null, { status: 204 });
		} else {
			return createdResponse(destination, false);
		}
	}
}

async function handle_move(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let overwrite = (request.headers.get('Overwrite') ?? 'T') !== 'F';
	let destination_header = request.headers.get('Destination');
	if (destination_header === null) {
		return new Response('Bad Request', { status: 400 });
	}
	let destination = parseDestinationPath(destination_header, request.url);
	if (destination === null) {
		return new Response('Bad Request', { status: 400 });
	}
	if (isSameOrDescendantPath(resource_path, destination)) {
		return new Response('Bad Request', { status: 400 });
	}
	let sourceLockResponse = await assertLockPermission(request, bucket, resource_path);
	if (sourceLockResponse !== null) {
		return sourceLockResponse;
	}
	let destinationLockResponse = await assertLockPermission(request, bucket, destination);
	if (destinationLockResponse !== null) {
		return destinationLockResponse;
	}

	// Check if the parent directory exists
	let destination_parent = getParentPath(destination);
	if (!(await hasCollectionResource(bucket, destination_parent))) {
		return new Response('Conflict', { status: 409 });
	}

	// Check if the destination already exists
	let destination_exists = await bucket.head(destination);
	if (!overwrite && destination_exists) {
		return new Response('Precondition Failed', { status: 412 });
	}

	let resource = await bucket.head(resource_path);
	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}
	if (resource.key === destination) {
		return new Response('Bad Request', { status: 400 });
	}

	if (destination_exists) {
		// Delete the destination first
		let deleteHeaders = new Headers();
		for (const headerName of INTERNAL_DELETE_FORWARD_HEADERS) {
			let headerValue = request.headers.get(headerName);
			if (headerValue !== null) {
				deleteHeaders.set(headerName, headerValue);
			}
		}
		let deleteResponse = await handle_delete(
			new Request(new URL(destination_header), {
				method: 'DELETE',
				headers: deleteHeaders,
			}),
			bucket,
		);
		if (!deleteResponse.ok) {
			return deleteResponse;
		}
	}

	let is_dir = resource?.customMetadata?.resourcetype === '<collection />';

	if (is_dir) {
		let depth = request.headers.get('Depth') ?? 'infinity';
		switch (depth) {
			case 'infinity': {
				let prefix = resource_path + '/';
				const move = async (object: R2Object) => {
					let target = destination + '/' + object.key.slice(prefix.length);
					target = target.endsWith('/') ? target.slice(0, -1) : target;
					let src = await bucket.get(object.key);
					if (src !== null) {
						await bucket.put(target, src.body, {
							httpMetadata: object.httpMetadata,
							customMetadata: getPreservedCustomMetadata(object.customMetadata),
						});
						await bucket.delete(object.key);
					}
				};
				let promise_array = [move(resource)];
				for await (let object of listAll(bucket, prefix, true)) {
					promise_array.push(move(object));
				}
				await Promise.all(promise_array);
				if (destination_exists) {
					return new Response(null, { status: 204 });
				} else {
					return createdResponse(destination, true);
				}
			}
			default: {
				return new Response('Bad Request', { status: 400 });
			}
		}
	} else {
		let src = await bucket.get(resource.key);
		if (src === null) {
			return new Response('Not Found', { status: 404 });
		}
		await bucket.put(destination, src.body, {
			httpMetadata: src.httpMetadata,
			customMetadata: getPreservedCustomMetadata(src.customMetadata),
		});
		await bucket.delete(resource.key);
		if (destination_exists) {
			return new Response(null, { status: 204 });
		} else {
			return createdResponse(destination, false);
		}
	}
}

async function handle_lock(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let depthHeader = request.headers.get('Depth');
	if (depthHeader !== null && !VALID_LOCK_DEPTHS.includes(depthHeader as (typeof VALID_LOCK_DEPTHS)[number])) {
		return new Response('Bad Request', { status: 400 });
	}
	let { timeout, expiresAt } = parseTimeout(request.headers.get('Timeout'));
	let body = await request.text();
	// Per WebDAV, an empty LOCK request body indicates a lock refresh operation.
	let requestedScope: LockDetails['scope'] = /<shared\b/i.test(body) ? 'shared' : 'exclusive';
	let requestLockTokens = getRequestLockTokens(request);
	if (body !== '' && !/<write\b/i.test(body)) {
		return new Response('Bad Request', { status: 400 });
	}
	let owner = extractLockOwner(body);
	let lockResponse = await assertLockPermission(request, bucket, resource_path, {
		ignoreSharedLocksOnTarget: body !== '' && requestedScope === 'shared',
	});
	if (lockResponse !== null) {
		return lockResponse;
	}

	let refreshTarget = body === '' ? await findMatchingLock(request, bucket, resource_path) : null;
	let resource = refreshTarget?.resource ?? (await bucket.head(resource_path));
	let currentLocks = getLockDetails(resource?.customMetadata);
	let existingLock = refreshTarget?.lockDetails;
	if (
		refreshTarget === null &&
		body === '' &&
		resource !== null &&
		currentLocks.length > 0 &&
		!currentLocks.some((currentLock) => requestLockTokens.includes(currentLock.token))
	) {
		return new Response('Locked', { status: 423 });
	}
	if (resource === null) {
		if (body === '') {
			return new Response('Bad Request', { status: 400 });
		}
		if (!(await hasCollectionResource(bucket, getParentPath(resource_path)))) {
			return new Response('Conflict', { status: 409 });
		}
		if (request.url.endsWith('/')) {
			return new Response('Conflict', { status: 409 });
		}

		await bucket.put(resource_path, new Uint8Array(), {
			customMetadata: {},
		});
		resource = await bucket.head(resource_path);
		currentLocks = [];
	}

	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}
	if (existingLock === undefined) {
		if (requestedScope === 'exclusive' && currentLocks.length > 0) {
			return new Response('Locked', { status: 423 });
		}
		if (requestedScope === 'shared' && currentLocks.some((lockDetail) => lockDetail.scope === 'exclusive')) {
			return new Response('Locked', { status: 423 });
		}
	}
	let depth: (typeof VALID_LOCK_DEPTHS)[number];
	if (existingLock !== undefined && depthHeader === null && body === '') {
		// Refreshing an existing lock without an explicit Depth header:
		// preserve the original lock depth instead of broadening it.
		depth = existingLock.depth;
	} else {
		depth = determineLockDepth(
			resource.customMetadata?.resourcetype,
			depthHeader as (typeof VALID_LOCK_DEPTHS)[number] | null,
		);
	}

	let lockDetails: LockDetails = {
		token: existingLock?.token ?? crypto.randomUUID(),
		owner: owner ?? existingLock?.owner,
		scope: existingLock?.scope ?? requestedScope,
		depth,
		timeout,
		expiresAt,
		root: getResourceHref(resource.key, resource.customMetadata?.resourcetype === '<collection />'),
	};
	let updatedLocks =
		existingLock === undefined
			? [...currentLocks, lockDetails]
			: currentLocks.map((currentLock) => (currentLock.token === existingLock.token ? lockDetails : currentLock));

	let source = await bucket.get(resource.key);
	if (source === null) {
		return new Response('Not Found', { status: 404 });
	}

	await bucket.put(resource.key, source.body, {
		httpMetadata: source.httpMetadata,
		customMetadata: withLockMetadata(resource.customMetadata, updatedLocks),
	});

	return new Response(
		`<?xml version="1.0" encoding="utf-8"?>\n<prop xmlns="DAV:"><lockdiscovery>${getLockDiscovery(updatedLocks)}</lockdiscovery></prop>`,
		{
			status: existingLock ? 200 : 201,
			headers: {
				'Content-Type': 'application/xml; charset=utf-8',
				'Lock-Token': `<urn:uuid:${lockDetails.token}>`,
				...(existingLock
					? {}
					: {
							Location: getResourceHref(resource.key, resource.customMetadata?.resourcetype === '<collection />'),
						}),
			},
		},
	);
}

async function handle_unlock(request: Request, bucket: R2Bucket): Promise<Response> {
	let resource_path = make_resource_path(request);
	let resource = await bucket.head(resource_path);
	if (resource === null) {
		return new Response('Not Found', { status: 404 });
	}

	let lockToken = request.headers.get('Lock-Token');
	if (lockToken === null) {
		return new Response('Bad Request', { status: 400 });
	}
	let lockResponse = await assertLockPermission(request, bucket, resource_path);
	if (lockResponse !== null) {
		return lockResponse;
	}

	let lockDetails = getLockDetails(resource.customMetadata);
	let normalizedToken = normalizeLockToken(lockToken);
	if (!lockDetails.some((lockDetail) => lockDetail.token === normalizedToken)) {
		return new Response('Conflict', { status: 409 });
	}

	let source = await bucket.get(resource.key);
	if (source === null) {
		return new Response('Not Found', { status: 404 });
	}

	await bucket.put(resource.key, source.body, {
		httpMetadata: source.httpMetadata,
		customMetadata: withLockMetadata(
			resource.customMetadata,
			lockDetails.filter((lockDetail) => lockDetail.token !== normalizedToken),
		),
	});

	return new Response(null, { status: 204 });
}

const DAV_CLASS = '1, 2';
const SUPPORT_METHODS = [
	'OPTIONS',
	'PROPFIND',
	'PROPPATCH',
	'MKCOL',
	'GET',
	'HEAD',
	'PUT',
	'DELETE',
	'COPY',
	'MOVE',
	'LOCK',
	'UNLOCK',
];

async function dispatch_handler(request: Request, bucket: R2Bucket): Promise<Response> {
	switch (request.method) {
		case 'OPTIONS': {
			return new Response(null, {
				status: 200,
				headers: {
					Allow: SUPPORT_METHODS.join(', '),
					DAV: DAV_CLASS,
				},
			});
		}
		case 'HEAD': {
			return await handle_head(request, bucket);
		}
		case 'GET': {
			return await handle_get(request, bucket);
		}
		case 'PUT': {
			return await handle_put(request, bucket);
		}
		case 'DELETE': {
			return await handle_delete(request, bucket);
		}
		case 'MKCOL': {
			return await handle_mkcol(request, bucket);
		}
		case 'PROPFIND': {
			return await handle_propfind(request, bucket);
		}
		case 'PROPPATCH': {
			return await handle_proppatch(request, bucket);
		}
		case 'COPY': {
			return await handle_copy(request, bucket);
		}
		case 'MOVE': {
			return await handle_move(request, bucket);
		}
		case 'LOCK': {
			return await handle_lock(request, bucket);
		}
		case 'UNLOCK': {
			return await handle_unlock(request, bucket);
		}
		default: {
			return new Response('Method Not Allowed', {
				status: 405,
				headers: {
					Allow: SUPPORT_METHODS.join(', '),
					DAV: DAV_CLASS,
				},
			});
		}
	}
}

function is_authorized(authorization_header: string, username: string, password: string): boolean {
	const encoder = new TextEncoder();

	const header = encoder.encode(authorization_header);
	const expected = encoder.encode(`Basic ${btoa(`${username}:${password}`)}`);

	return timingSafeEqual(header, expected);
}

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const { bucket } = env;

		if (
			request.method !== 'OPTIONS' &&
			!is_authorized(request.headers.get('Authorization') ?? '', env.USERNAME, env.PASSWORD)
		) {
			return new Response('Unauthorized', {
				status: 401,
				headers: {
					'WWW-Authenticate': 'Basic realm="webdav"',
				},
			});
		}

		let response: Response = await dispatch_handler(request, bucket);

		// Set CORS headers
		response.headers.set('Access-Control-Allow-Origin', request.headers.get('Origin') ?? '*');
		response.headers.set('Access-Control-Allow-Methods', SUPPORT_METHODS.join(', '));
		response.headers.set(
			'Access-Control-Allow-Headers',
			[
				'authorization',
				'content-type',
				'depth',
				'overwrite',
				'destination',
				'range',
				'if',
				'lock-token',
				'timeout',
			].join(', '),
		);
		response.headers.set(
			'Access-Control-Expose-Headers',
			[
				'content-type',
				'content-length',
				'dav',
				'etag',
				'last-modified',
				'location',
				'date',
				'content-range',
				'lock-token',
			].join(', '),
		);
		response.headers.set('Access-Control-Allow-Credentials', 'false');
		response.headers.set('Access-Control-Max-Age', '86400');

		return response;
	},
};
