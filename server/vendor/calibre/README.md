# Vendored from Calibre

`metadata_sqlite.sql` is Calibre's own schema for a library database, copied
**verbatim** from `calibre.app/Contents/Resources/resources/metadata_sqlite.sql`
(Calibre 9.5, `user_version` 27).

It is here for exactly one purpose: creating an **empty but genuine** Calibre
library on an instance that has none, so Calibre-Web has something to open and
the household can upload its first book. Calibre-Web does not create a library
— it redirects to `/admin/dbconfig` and waits to be shown one — and a household
served over the web has no desktop Calibre to make it with.

Writing our own "compatible" schema was the alternative, and it is the fragile
one: the triggers, the collations and the custom-column machinery are not
things you reimplement correctly by reading a dump. A real library made by
Calibre's own SQL is a library every Calibre in the world can open.

**Do not edit it.** To move to a newer Calibre, copy the file again and check
that `user_version` still matches what `server/scripts/ensure-calibre-library.ts`
sets.

## Licence

Calibre is Copyright (C) Kovid Goyal and released under the **GNU GPL v3**. Chez
Maurice is AGPL v3, with which GPL v3 is compatible; this file keeps its
original licence and authorship, and is redistributed unmodified.

Upstream: https://github.com/kovidgoyal/calibre
