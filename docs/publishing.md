# Publishing `@bassfish/cli`

The npm package is public under the `@bassfish` organization. Releases are built from committed source; never publish from a development worktree with unrelated changes.

## First publication

The package must exist before its npm trusted publisher can be configured. From a clean checkout of the release commit, sign in as an npm account with public-package permission in `@bassfish`, then run:

```sh
npm ci
npm run setup:dolt
npm run ci
npm run package:check
npm publish --access public
npm view @bassfish/cli@0.1.0 name version dist.integrity
```

The first publication uses maintainer authentication and 2FA. Do not create a `v0.1.0` publish tag after this manual bootstrap; automated tag publication starts with the next version.

Once the package page exists, configure its GitHub Actions trusted publisher for repository `tfukaza/bassfish`, workflow `publish.yml`, with direct publishing allowed. With a current npm CLI, the equivalent command is:

```sh
npm trust github @bassfish/cli \
  --repo tfukaza/bassfish \
  --file publish.yml \
  --allow-publish
```

No npm token is stored in GitHub. The workflow uses OIDC and npm attaches provenance to releases from this public repository.

## Subsequent releases

1. Update the version in both `package.json` and `package-lock.json`.
2. Run `npm run release:check` and complete the live host/OS qualification in [release-qualification.md](release-qualification.md).
3. Commit the release, create the exact tag `v<package-version>`, and push the tag.
4. Confirm both operating-system qualification jobs and the publish job pass.
5. Verify the registry version and provenance on the npm package page.

The workflow rejects a tag that does not exactly match `package.json`. npm versions and Git tags are immutable release identities in v0; fix forward with a new version rather than replacing an artifact.
