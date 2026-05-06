# Talk With Your Zo Agent Notes

This repo mirrors a Zo Space demo:

- Page route: `/talk-with-zo`
- API route: `/api/talk-with-zo`

Keep route source in `routes/` aligned with the live Zo Space routes after every deploy.

Do not put secrets in this repo. The API route expects `ZO_API_KEY` to be configured in Zo Secrets.

Prefer small commits:

1. docs or architecture
2. route implementation
3. deploy/verification notes

Before changing live routes, inspect current Zo Space state and avoid overwriting unrelated pages.
