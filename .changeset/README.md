# Changesets

Every pull request that changes a published package's behavior or public
configuration must include a changeset:

```bash
npm run changeset
```

Choose only the affected packages, select the SemVer bump, and write a
user-facing summary. Repository infrastructure, tests, and documentation that
do not change a package do not require a changeset.

The release workflow keeps package versions independent. Do not edit package
versions or changelogs manually.
