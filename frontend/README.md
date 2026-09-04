# Browspark landing page

A standalone static site using HTML, CSS, and a small JavaScript module. It shares the extension's neutral dark palette and green accent. There is no frontend framework, hydration, runtime dependency, or external font request. Bun is used only for local serving and minifying the production JavaScript and CSS.

## Develop

With Bun installed, from the repository root:

```sh
cd frontend
bun run dev
```

Open http://127.0.0.1:3000. Refresh after editing a file. To choose another port, run `PORT=3001 bun run dev`.

## Build and preview

```sh
bun run build
bun run preview
```

The build creates `frontend/dist/` with `index.html`, minified CSS and JavaScript, and local assets. Preview uses the same local address and supports the `PORT` environment variable.

Run `bun run test` to rebuild and smoke-test the production server, static asset references, and path restrictions. The test uses an ephemeral local port and shuts its server down afterward.

## Deploy

Upload the contents of `frontend/dist/` to any static host. When configuring a host from the repository, set its working directory to `frontend`, its build command to `bun run build`, and its publish directory to `dist`. The deployed site does not need Bun or a server-side application. Enable compression on the host for HTML, CSS, JavaScript, and SVG files.

Edit `index.html` for content and links, `styles.css` for styling, and `main.js` for interactions. Keep the logos in `assets/`; their source credits are included alongside the assets.

## Verification

Local production build, Lighthouse simulated mobile, September 12, 2026: 100 performance, 100 accessibility, 100 best practices, and 100 SEO. LCP was 1.51 seconds, total blocking time 0 ms, and transfer size 78.2 KiB across 11 local requests. These are local lab results; production hosting and network conditions affect performance. Reports are in the ignored `.reports/` folder.

Browser checks covered desktop, 390 px and 320 px layouts, preview switches and views, all six client configurations, copying, remembered selection, mobile navigation, and FAQ expansion.
