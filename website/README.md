# Bassfish website

The first site has two sections: explain the shared threads and notes, then install Bassfish and connect an agent host. The pond is the only active backdrop.

## Content and design plan

- Lead with the requested tagline, **headless chat and notes for agent teams**, and a plain explanation of who uses it and why.
- Let the existing pond carry the visual identity. Keep white space around the miniature, use Helvetica Neue, charcoal text, and olive accents. Keep the main content readable without motion or WebGL.
- Explain conversations and durable notes in two short paragraphs. Keep the exact turn protocol in the setup guide.
- Offer manual installation with visible prerequisites, host commands, and a first prompt. Provide a copyable `setup.md` link for someone who wants their agent to do the setup.
- Publish `llms.txt` as a small documentation index, `setup.md` as the complete installation/use document, and `index.md` as a text version of the homepage. These are ordinary static files an agent can fetch; they do not execute an installer.

The next useful addition would be a short demo captured against the current API. The older marketing film uses a previous preview API, so it is not on this homepage. Add more pages only when the two-section page no longer answers the questions people bring to it.

Writing and visual references: [Clear Technical English](https://hakanalpay.com/english/) and [Taste Minimalist UI](https://github.com/Leonxlnx/taste-skill/blob/main/skills/minimalist-skill/SKILL.md). The existing pond and the user's preference for a clean page take precedence over the skill's stock illustration and motion suggestions.

## Build and preview

From the repository root:

```sh
npm ci --prefix website
npm run build --prefix website
npm run check --prefix website
npm run preview --prefix website
```

Open http://127.0.0.1:8081/bassfish/. Preview serves the build under the same project path used by GitHub Pages. Use `PORT=8082` to change the local port.

Source HTML, CSS, JavaScript, and Markdown live here. `scripts/build.mjs` writes only publishable files to `website/dist/`, which is ignored by Git and excluded from the CLI package. The build copies the current pond runtime from `marketing/backdrop/pond/`, preserves the vendored Three.js license, and encodes web-sized WebP copies of the active PNG textures with alpha preserved. Source artwork remains unchanged. The existing standalone pond preview is also published at `backdrop/pond/`.

`BASSFISH_SITE_URL` optionally overrides the canonical site URL (including a trailing project path). The default is https://tfukaza.github.io/bassfish/. All browser assets and internal links use relative paths.

## GitHub Pages

`.github/workflows/pages.yml` builds and checks the static artifact on relevant pull requests and pushes to `main`. Only pushes to `main` and manual runs deploy. The repository's Pages source must be **GitHub Actions**. The deploy job uses the `github-pages` environment and the Pages/OIDC permissions from [GitHub's Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

The checkpoint before removing the open-water demo is `8ec2207`. View or restore that version from Git history if needed; no open-water code or assets ship with this site.

## Verification and upkeep

The build check validates relative asset references, Markdown links, required entry points, deployment size, and the absence of source/QA files. Browser checks cover the project path, narrow screens, keyboard tabs, copy actions, fallback rendering, reduced motion, and missing textures.

To run browser checks with an existing Playwright installation:

```sh
BASSFISH_PLAYWRIGHT_MODULE=/absolute/path/to/playwright npm run check:browser --prefix website
```

Run the preview server first. Screenshots and results go to ignored `website/qa/`. `BASSFISH_SITE_TEST_URL` can target a different preview or the deployed URL. Update `setup.md` with CLI/tool changes; examples must match `src/api.ts`, and the version and requirements must match the package being published.
