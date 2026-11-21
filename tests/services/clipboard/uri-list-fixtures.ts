/**
 * @fileoverview A `text/uri-list` as a Linux file manager or another
 * application might publish it, with the paths the `files` format reads from
 * it. Shared by the uri-list reader and both Linux backend suites.
 * @module tests/services/clipboard/uri-list-fixtures
 */

/**
 * CRLF lines (RFC 2483) with a comment, a remote host, a non-file URI, two
 * paths that cannot be listed one per line, a malformed escape, then an
 * LF-terminated line and an unterminated last line.
 */
export const URI_LIST = [
  '# copied from a file manager',
  'file:///home/u/a%20b.txt',
  'file://localhost/home/u/caf%C3%A9.txt',
  'https://x.test/page',
  'file://other-host/srv/share.txt',
  'file:///home/u/line%0Abreak.txt',
  'file:///home/u/latin%E9.txt',
  'file:///home/u/100%.txt',
  'file:///home/u/doc%202%20e%CC%81.txt\nfile:///home/u/last.txt',
].join('\r\n');

/** The local file paths `URI_LIST` names, in order. */
export const URI_LIST_PATHS = [
  '/home/u/a b.txt',
  '/home/u/café.txt',
  '/home/u/100%.txt',
  '/home/u/doc 2 é.txt',
  '/home/u/last.txt',
];

/** Paths `URI_LIST` names that the `files` format leaves out: a line break, and bytes that are not UTF-8. */
export const URI_LIST_OMITTED = 2;
