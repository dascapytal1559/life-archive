# The health module

The life archive's Health Record page (the console's `/life-archive/dev/health-record`): every blood test, screen, body scan and physical assessment the archive keeps, each judged by one authority on range, graded by how far past its line and ordered so what needs looking at is at the top; the records that are no lab result (immunisations and what they protect against, medicines, Medicare's claims); and the physical assessment with the highest heart rate a trusted recording holds. The core's README says how it all works ("Health") and how a module is laid out, found and switched (`docs/modules.md`).

It runs inside a life archive, never on its own: the core loads `module.ts` (its server half) and `viewer.tsx` (its page half), and the module imports the core through the SDK alone (`../../sdk/`).

- `module.ts`: its route (`GET /life-archive/api/m/health`), the runs transcribed by hand it offers the Fitness page (`RunsByHand`), its made-up results for the testing data, and its lines of the privacy policy (`server/privacy.ts`).
- `viewer.tsx`: the Health Record aspect, one view for each of its own tabs (`viewer/HealthSection.tsx` wraps `viewer/HealthView.tsx` in the console's blocks).
- `wire.ts`: the one answer the page draws, and the route's address, shared by both halves.
- `server/`: the catalogue of tests, the authority on range and how each range was built, the readers of Everlab's and QML's reports (PDFKit through `pdfLines.swift`), the import, the store (`modules/health/imported.json`, `modules/health/by-hand.json` and `modules/health/lab-intervals.json`, the labs' printed intervals for the tests no guideline covers, in the archive's folder; in `health/` of an archive kept before modules kept their files in theirs, read there until `npm run archive -- migrate module-data` moves them) and the judging.
- `fixtures/`: a made-up man's results, written as real PDFs by `makePdf.swift`, for the tests and `npm run testing-data`.
- `cli.ts`: `npm run health -- import [--dry-run] | ranges`.

Its data is content, by the captain's word: real results stay in the archive's folder, and the tests and the testing data use only the made-up man's. Switch it off with `"modules": {"health": false}` in the archive's `settings.json`.
