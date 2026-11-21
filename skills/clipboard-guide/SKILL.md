---
name: clipboard-guide
description: Gates for the clipboard_* tools (clipboard_read, clipboard_write, clipboard_inspect) — choosing a format when auto would return copied-file paths or an image, reading one item of a multi-item clipboard, paging large values, telling an empty clipboard from content the server cannot return, and replacing the clipboard without losing what the user copied. Use when reading what the user copied, putting text or HTML on their clipboard, or when a clipboard_read result is not what was expected.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.1"
---

## Scope

The clipboard_* tools reach the clipboard of the machine the server process runs on. That is the user's own clipboard only when the server runs locally, inside their desktop session; a server reached over HTTP on another host reads that host's clipboard.

What the user last copied can be a password or a token. Read the clipboard when the task is about it, and quote back only what the task needs.

Copied files read as their paths only: the `files` format lists the absolute paths, which belong to the machine the server runs on. The server never opens a file, so its contents are out of reach.

When clipboard_write is missing from the tool list, the deployment is read-only (`CLIPBOARD_READ_ONLY`). Tell the user writing is disabled; there is no other write path.

## Identifiers

| Identifier | Comes from | Carries |
|:--|:--|:--|
| Format name (`text`, `html`, `rtf`, `image`, `files`) | clipboard_inspect's `availableFormats`, or the `format` a clipboard_read response reports | Which representation to read |
| `itemCount`, `item` | `itemCount` on every clipboard_inspect and clipboard_read response; `item` is a 0-based index below it | One item of a multi-item clipboard, read alone |
| `nextOffset` | The previous clipboard_read response; absent once `complete` is true | Where the next slice starts |
| `representationId` | Every clipboard_read response | The value, format, and item a slice was cut from; the same token on any slice of an unchanged value |

## Gates

- **Name the format the user means.** "auto" ranks files first and an image next: it returns the copied files' paths whenever any are present, and an image whenever one is, even beside HTML and text. Office-style apps can publish a rendered picture of a selection, and a file manager publishes a file's icon beside its path. When the user wants the table, the prose, or the markup, read "html" or "text" explicitly; keep "auto" for "what did I copy?".
- **Files are paths, never contents.** A "files" read is the absolute paths, one per line, on the server's machine; they open from a shell or another tool on that machine and nowhere else. A path holding a line break (on Linux, also non-UTF-8 bytes) is left out, and the notice counts it. A file URL that names no local path, such as a web URL, is not a file, and inspection lists no "files" for it.
- **Count the items before trusting a multi-item read.** On macOS `itemCount` above 1 means several items (images multi-selected in Photos, files copied in Finder). Without `item`, "text" joins every item's text, "rtf" is one document built from every item holding text, HTML, or RTF, "html" comes from the first item that has it, "image" from the first item holding a PNG (else the first holding another image type), and "files" lists every item; the notice says which, and an item read is the way to know exactly which item a value came from. Pass `item` to read one alone, and on every continuation of a chunked read, since changing it fails as `representation_changed`. An `item` at or past `itemCount` fails `format_unavailable`. Linux and Windows hold one item.
- **"Nothing readable" is not "nothing copied."** `primaryFormat: "empty"` with a non-empty `rawTypes` list means something is on the clipboard in types this server cannot return: a file URL that names no local path, an app-private type, or on Linux an image offered only as JPEG or BMP (only `image/png` counts there). Describe what `rawTypes` shows instead of telling the user the clipboard is empty.
- **Text, HTML, and RTF arrive as the source's bytes decoded as UTF-8.** HTML a source published as UTF-16 comes out garbled; switch formats when content reads as noise. On macOS an "rtf" read returns `public.rtf` as written; with none, it converts a flat RTFD copy (`com.apple.flat-rtfd`) to RTF, which is the one RTF read that is not the source's bytes, and an RTFD it cannot decode is `format_unavailable`. Prefer "html" or "text" unless the user needs RTF itself.
- **Writing destroys everything but plain text.** clipboard_write, clear included, replaces every representation, copied files among them. `previousContent` restores plain text up to 512 KB and nothing else: an image, copied files, the HTML or RTF of a rich copy, and longer text are gone. Write only when the user asked for the clipboard to change; when clipboard_inspect shows an image, files, or rich content they have not said to discard, confirm first.
- **Exact characters need "text".** On macOS and Windows an "html" write also publishes a tag-stripped plain-text fallback that keeps line breaks and tab-separates table cells but drops list markers and numbering, and on Linux a plain-text paste can receive the raw markup. Write "text" whenever the paste target may be plain text and the exact characters matter (commands, code, numbered lists).
- **Continue from `nextOffset`, never a computed offset.** Text, HTML, and RTF slices end on whole UTF-8 characters, so a slice can run up to 3 bytes short of the limit and `nextOffset` is not offset + limit. An offset that lands mid-character drops that character's bytes without an error.
- **Image size is the PNG's, not the inspected type's.** The 5 MB read limit applies to the PNG clipboard_read produces. macOS always re-encodes it, and Windows does whenever it comes from a bitmap, so its size can differ from every image size clipboard_inspect lists (`public.png`, `public.tiff`, a device-independent bitmap). Read, and let `content_too_large` (its data carries `bytes` and `limit`) decide whether to slice.
- **A whole image costs about 2.7 times its PNG size in response.** It arrives as an image block and again as base64 in the structured result, so a 4 MB screenshot is a response of about 10.7 MB. When the client caps tool-result size below that, read it in slices.
- **A sliced image cannot be viewed.** Only a whole image arrives as an image block. Slices are PNG byte chunks, worth fetching only when a code tool can decode and join them into a file. Without one, tell the user the image is over the limit and ask them to save it as a file instead.

## Workflows

### Reading

An explicit format reads directly; "auto" runs a full inspection before every read. Call clipboard_inspect on its own only when the choice depends on sizes, `rawTypes`, or whether anything is there at all — not as a ritual before an "auto" read that inspects anyway.

### Paging a large value

1. Read with offset 0.
2. On every continuation pass `nextOffset`, the previous `representationId`, the same `item` (if any), and the format the first response reported. Not "auto": it re-inspects each call and can resolve to another format, which fails as `representation_changed`.
3. Stop when `complete` is true. Text: join the `content` strings in order. Image: base64-decode each slice on its own and concatenate the bytes in offset order.
4. `representation_changed` means the clipboard now holds a different value (on macOS, a source re-publishing identical content also counts): discard what you have and restart at offset 0 with no `representationId`. `format_unavailable` mid-way means the clipboard was emptied or no longer offers that format; ask the user to copy again.
