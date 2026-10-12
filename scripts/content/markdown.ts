// review.md -> sanitized HTML. Raw HTML in Markdown is dropped, links are
// limited to safe protocols, and local images are replaced by processed renditions.

import type { Element, Root as HastRoot } from 'hast';
import type { Image, Root as MdastRoot } from 'mdast';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { unified } from 'unified';
import { SKIP, visit } from 'unist-util-visit';
import type { ImageAsset } from '../../shared/content/model.ts';

/** Collects the local image paths referenced by a Markdown document. */
export function listMarkdownImages(markdown: string): { url: string; alt: string }[] {
  const tree = unified().use(remarkParse).use(remarkGfm).parse(markdown);
  const images: { url: string; alt: string }[] = [];
  visit(tree, 'image', (node: Image) => {
    images.push({ url: decodeURI(node.url), alt: node.alt ?? '' });
  });
  return images;
}

const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), 'figure', 'figcaption'],
  attributes: {
    ...defaultSchema.attributes,
    img: [
      ...(defaultSchema.attributes?.img ?? []),
      'srcSet',
      'sizes',
      'width',
      'height',
      'loading',
      'decoding',
    ],
  },
  protocols: { ...defaultSchema.protocols, href: ['http', 'https', 'mailto'] },
};

/**
 * Renders review Markdown. `resolveImage` maps each local image path to its
 * processed asset; every image path must already have been validated.
 */
export async function renderMarkdown(
  markdown: string,
  resolveImage: (url: string) => ImageAsset,
): Promise<string> {
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(() => (tree: MdastRoot) => {
      // The page title is the only <h1>; shift review headings so they start at <h2>.
      let minDepth = 6;
      visit(tree, 'heading', (node) => {
        minDepth = Math.min(minDepth, node.depth);
      });
      const shift = Math.max(0, 2 - minDepth);
      visit(tree, 'heading', (node) => {
        node.depth = Math.min(6, node.depth + shift) as typeof node.depth;
      });
    })
    .use(remarkRehype)
    .use(rehypeSanitize, sanitizeSchema)
    .use(() => (tree: HastRoot) => {
      visit(tree, 'element', (node: Element, _index, parent) => {
        if (node.tagName === 'img') {
          const asset = resolveImage(decodeURI(String(node.properties.src ?? '')));
          const caption = typeof node.properties.title === 'string' ? node.properties.title : '';
          node.properties = {
            src: asset.src,
            srcSet: asset.srcset,
            sizes: '(min-width: 768px) 720px, 100vw',
            width: asset.width,
            height: asset.height,
            alt: String(node.properties.alt ?? ''),
            loading: 'lazy',
            decoding: 'async',
          };
          // A paragraph holding only an image becomes a <figure>, with the
          // Markdown image title as its caption.
          if (
            parent?.type === 'element' &&
            parent.tagName === 'p' &&
            parent.children.every(
              (child) =>
                child === node || (child.type === 'text' && child.value.trim().length === 0),
            )
          ) {
            parent.tagName = 'figure';
            parent.children = [node];
            if (caption) {
              parent.children.push({
                type: 'element',
                tagName: 'figcaption',
                properties: {},
                children: [{ type: 'text', value: caption }],
              });
            }
          }
          return SKIP;
        }
        if (node.tagName === 'a') {
          const href = String(node.properties.href ?? '');
          if (/^https?:/i.test(href)) {
            node.properties.target = '_blank';
            node.properties.rel = ['noopener', 'noreferrer'];
          }
        }
        return undefined;
      });
    })
    .use(rehypeStringify)
    .process(markdown);
  return String(file);
}
