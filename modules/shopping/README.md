# The shopping module

The life archive's Shopping page (the console's `/life-archive/dev/shopping`): what the owner's suppliers have on special, every one of them in one layout, so no supplier's own site needs visiting. The server pulls each supplier's public storefront each morning at 08:00 local time, once as it starts when today has no pull, and whenever the page's Refresh asks. The core's `docs/features.md` says how it works ("Shopping"), and `docs/modules.md` how a module is laid out, found and switched.

It runs inside a life archive, never on its own: the core loads `module.ts` (its server half) and `viewer.tsx` (its page half), and the module imports the core through the SDK alone (`../../sdk/`). It was a part of the core until 8 November 2026; its route kept the address it had there, and its data the place it had in the archive's folder.

- `module.ts`: its route (`GET` and `POST /life-archive/api/shopping`, a mount, and the module's own `/life-archive/api/m/shopping`), the `Shopping` service it offers (the latest pull, and a pull now), its morning pulls (its `work`, through that service), and its lines of the privacy policy.
- `viewer.tsx`: the Shopping aspect, and its one view, On special (`viewer/ShoppingSection.tsx`, its arithmetic in `viewer/format.ts`, its look in `viewer/shopping.css`).
- `wire.ts`: the route's address, a pull's shape as it is kept, and the answer the page draws, shared by both halves.
- `server/`: the route (`http.ts`), the service and the mornings (`pull.ts`), each storefront kind's reader (`fetch.ts`, parsed in `parse.ts`: Shopify's feed or collection page, a headless Shopify storefront's Storefront API, WooCommerce's Store API, a Wix page) and the suppliers (`suppliers.ts`).

## Setting it up

It is unfinished, so off in a fresh install: switch it on with `"modules": {"shopping": true}` in the archive's `settings.json` (or every page with `"pages": "all"`), and off with `false`. Off, nothing of it runs: no pulls, its route answers 404, and its page is not in the rail.

Its suppliers are `shopping/suppliers.json` in the archive's folder, a list of entries like this one (`server/suppliers.ts` has the shape; the address is made up):

```json
[{ "id": "sample-butcher", "name": "Sample Butcher", "url": "https://butcher.example/collections/specials", "adapter": "shopify", "listsSpecials": false }]
```

- `adapter`: how its storefront is read, `shopify`, `shopify-storefront`, `woocommerce` or `wix`; a storefront of another kind needs an adapter in `server/fetch.ts`.
- `listsSpecials`: whether `url` lists only specials, so everything in stock there counts as one, marked down or not; false where it lists more.
- `specialsCategory` (WooCommerce): the product category whose products are its specials.

The file is read as the server starts: start it again after changing it. With no file there are no suppliers and no pulls, and the page says where they go.

## Its data

Each pull is kept whole in the archive's folder, `shopping/pulls/<when, UTC>.json`, so the history grows; the page shows the latest. A pull reads the suppliers' public storefronts alone, never behind a sign-in, and holds nothing of anyone's: prices, names and pictures the shops publish. Which shops the owner watches is theirs, so `suppliers.json` stays in the archive's folder, never in the repository.
