# Gratis development

- All ongoing feature work and pushes belong to the `tnash/gratis-community` repository, a fork of `earlyaidopters/gratis-community`. Never push these changes to `earlyaidopters/gratis-community` or the public core.
- There is one installed application: `/Applications/Gratis.app`, using bundle ID `com.gratis.desktop` and the existing `Gratis` data directory. Community is the code repository, not a second app, palette or user profile.
- Preserve the original Gratis desktop UI and all existing user chats, settings, memory, files and credentials when updating the app. Do not replace the profile with starter roles or test data.
- Never copy personal runtime data, credentials, private chats or screenshots into this repository. Test using isolated synthetic profiles.
- Keep `origin` and `upstream` on `tnash/gratis-community`; `upstream` is fetch-only (its push URL stays disabled).
- Run `npm run check`, relevant desktop/mobile checks and a package identity check.
