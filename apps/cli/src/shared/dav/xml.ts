// biome-ignore lint/correctness/noUnresolvedImports: @xmldom/xmldom declares its types in an ambient module, which Biome does not resolve; tsc checks these names.
import { DOMParser, type Element, type Node } from '@xmldom/xmldom';
import { Effect } from 'effect';
import { DavError } from '../errors/dav';

export const ns = {
  dav: 'DAV:',
  caldav: 'urn:ietf:params:xml:ns:caldav',
  carddav: 'urn:ietf:params:xml:ns:carddav',
  calendarServer: 'http://calendarserver.org/ns/',
  apple: 'http://apple.com/ns/ical/',
} as const;

// One <response> of a multistatus reply, with the properties the server
// returned. Properties from propstats with a non-2xx status are left out.
export type DavResource = {
  readonly href: string;
  readonly props: ReadonlyArray<Element>;
};

const elementNode = 1;

const matches = (
  element: Element,
  namespace: string | undefined,
  localName: string | undefined,
): boolean =>
  (namespace === undefined || element.namespaceURI === namespace) &&
  (localName === undefined || element.localName === localName);

export const childElements = (
  parent: Element,
  namespace?: string,
  localName?: string,
): ReadonlyArray<Element> => {
  const found: Array<Element> = [];
  for (
    let node: Node | null = parent.firstChild;
    node;
    node = node.nextSibling
  ) {
    if (
      node.nodeType === elementNode &&
      matches(node as Element, namespace, localName)
    ) {
      found.push(node as Element);
    }
  }
  return found;
};

export const firstChild = (
  parent: Element,
  namespace: string,
  localName: string,
): Element | undefined => childElements(parent, namespace, localName)[0];

export const textOf = (element: Element | undefined): string | undefined => {
  const text = element?.textContent?.trim();
  return text === undefined || text === '' ? undefined : text;
};

const statusLine = /^HTTP\/[\d.]+\s+(?<code>\d{3})/u;
const httpOk = 200;
const httpMultipleChoices = 300;

export const isSuccessStatus = (status: number): boolean =>
  status >= httpOk && status < httpMultipleChoices;

const statusCode = (element: Element | undefined): number | undefined => {
  const code = statusLine.exec(textOf(element) ?? '')?.groups?.code;
  return code === undefined ? undefined : Number(code);
};

// A propstat without a status counts as found.
const isFound = (status: number | undefined): boolean =>
  status === undefined || isSuccessStatus(status);

const toResource = (response: Element): DavResource | undefined => {
  const href = textOf(firstChild(response, ns.dav, 'href'));
  if (href === undefined) {
    return undefined;
  }
  const props = childElements(response, ns.dav, 'propstat')
    .filter((propstat) =>
      isFound(statusCode(firstChild(propstat, ns.dav, 'status'))),
    )
    .flatMap((propstat) => {
      const prop = firstChild(propstat, ns.dav, 'prop');
      return prop === undefined ? [] : childElements(prop);
    });
  return { href, props };
};

export const parseMultistatus = (
  text: string,
): Effect.Effect<ReadonlyArray<DavResource>, DavError> =>
  Effect.try({
    try: () =>
      new DOMParser().parseFromString(text, 'text/xml').documentElement,
    catch: (cause) =>
      new DavError({
        message: `the server sent malformed XML: ${String(cause)}`,
      }),
  }).pipe(
    Effect.flatMap((root) =>
      root?.namespaceURI === ns.dav && root.localName === 'multistatus'
        ? Effect.succeed(
            childElements(root, ns.dav, 'response').flatMap((response) => {
              const resource = toResource(response);
              return resource === undefined ? [] : [resource];
            }),
          )
        : Effect.fail(
            new DavError({
              message: 'the server did not answer with a DAV multistatus',
            }),
          ),
    ),
  );

export const findProp = (
  resource: DavResource,
  namespace: string,
  localName: string,
): Element | undefined =>
  resource.props.find(
    (prop) => prop.namespaceURI === namespace && prop.localName === localName,
  );

export const propText = (
  resource: DavResource,
  namespace: string,
  localName: string,
): string | undefined => textOf(findProp(resource, namespace, localName));

// The <href> values inside a property such as calendar-home-set.
export const propHrefs = (
  resource: DavResource,
  namespace: string,
  localName: string,
): ReadonlyArray<string> => {
  const prop = findProp(resource, namespace, localName);
  return prop === undefined
    ? []
    : childElements(prop, ns.dav, 'href').flatMap((href) => {
        const text = textOf(href);
        return text === undefined ? [] : [text];
      });
};

export const hasResourceType = (
  resource: DavResource,
  namespace: string,
  localName: string,
): boolean => {
  const types = findProp(resource, ns.dav, 'resourcetype');
  return (
    types !== undefined && firstChild(types, namespace, localName) !== undefined
  );
};
