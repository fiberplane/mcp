# mcp-lit with auth (featuring: Clerk)

This is an example of using mcp-lite with auth, using Clerk as the auth provider.

## Configuration

Set secret variables in `.dev.vars`

```sh
# Fill in the values for the secret variables from the example file
cp .dev.vars.example .dev.vars
```

Create an OAuth app in Clerk: https://dashboard.clerk.com/last-active?path=user-authentication/oauth-applications

Copy your Clerk OAuth client secret and client ID from the OAuth app you created into your `.dev.vars` file.

Add a redirect URI to the OAuth app in the Clerk dashboard.

Enable Dynamic Client Registration using the toggle in the Clerk dashboard: https://dashboard.clerk.com/last-active?path=user-authentication/oauth-applications


## Development



Run the development server

```sh
bun install
bun dev
```

## Deployment 

```sh
bun run deploy
```

## Type Generation

[For generating/synchronizing types based on your Worker configuration run](https://developers.cloudflare.com/workers/wrangler/commands/#types):

```sh
bun run cf-typegen
```

Pass the `CloudflareBindings` as generics when instantiation `Hono`:

```ts
// src/index.ts
const app = new Hono<{ Bindings: CloudflareBindings }>()
```
