# Posters in Overroot

Create a project with **Academic Classic poster**, **Modern ML poster**, or **Visual Results poster**. The setup form accepts a title, subtitle, authors, affiliation, A0/A1 or custom dimensions, orientation, and two to four columns. A poster is a normal Overroot project: sharing, collaborative editing, history, agent credentials, source ZIP export, and isolated compilation use the existing project permissions and routes.

The entry point is `poster.tex`. Edit text in `sections/*.tex`; put vector PDF figures in `figures/` and reference them with relative paths. `poster-layout.tex` contains shared layout macros. `config.tex` contains the print dimensions and metadata created by the setup form; edit it in **Files** to change settings later. All new poster text is placeholder guidance, not scientific evidence. Avoid treating example wording as a research claim.

For custom sizes, width and height are the final printed dimensions; orientation applies to A0/A1 presets. The generated source enables scalable Computer Modern fonts for poster-size headings.

Compile `poster.tex`. The PDF pane measures its first page and shows page count and width × height in millimetres. Check that there is exactly one page and that the dimensions match the print order. Download the PDF or export the full source ZIP from the workspace. The measurement does not certify font embedding, image resolution, trimming, or visual alignment, so inspect the exported PDF before printing. The viewer limits its raster bitmap size for large pages; this changes preview sharpness at high zoom, not the vector PDF download.

Poster source layouts were adapted from the MIT-licensed [Overposter](https://github.com/Slavov88/Overposter) project. Its license notice is retained in [OVERPOSTER-LICENSE.txt](OVERPOSTER-LICENSE.txt) and each generated project's `OVERPOSTER-LICENSE.txt`, including source ZIP exports. The surrounding Overroot integration is contributed under this repository's AGPL-3.0-only license.
