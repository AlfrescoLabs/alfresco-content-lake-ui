# Contributing

This project is part of the **App for OpenArch** PoC projects. Contributions are welcome.

## Before You Start

- Read the [README](README.md) to understand how the ACA extension is structured and installed.
- Check the open issues before starting new work.
- For significant changes, open an issue first to discuss the approach.

## Development Setup

`ext-rag/` is not a standalone workspace. To develop and test the extension:

1. Clone [alfresco-content-app](https://github.com/Alfresco/alfresco-content-app) as a sibling.
2. Copy `ext-rag/` into the ACA workspace:
   ```bash
   cp -r ext-rag /path/to/alfresco-content-app/projects/ext-rag
   ```
3. Register and configure the extension in ACA (see [README](README.md)).
4. Run from the ACA workspace:
   ```bash
   npm start        # serve
   ng test ext-rag  # unit tests
   ```

## Making Changes

1. Fork the repository and create a branch from `main`.
2. Make your changes in `ext-rag/src/`.
3. Validate in ACA as described above.
4. Open a pull request. Describe what changed and why.

## Commit Messages

Use the format: `type: short description`

Types: `feat`, `fix`, `docs`, `chore`, `test`
