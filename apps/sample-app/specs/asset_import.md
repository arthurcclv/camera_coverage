# Sample App — Asset import (bringing files in from outside the scene folder)

The feature spec for **getting a file into a scene**: a picker that reaches anywhere on
disk, a dependency-resolution step for models that ship as more than one file, and a
**save** that writes the bytes into the scene folder's `assets/`. It is the import path
for **both** asset kinds — mesh assets (`geometry_assets.md`) and splat captures
(`gaussian_splats.md`) — which is why it is its own document rather than a section in
either: the two dialogs it replaces asked the same question and answered it the same
way, and the answer no longer belongs to one kind.

Companion to [`spec.md`](./spec.md); this document owns the full behavior of the
feature, and §14 lists the edits required in `spec.md`, `geometry_assets.md` and
`gaussian_splats.md` so the four stay consistent (workflow rule: spec-first, no drift).

> **Terms, first use.**
>
> **Scene folder** — the directory granted by `showDirectoryPicker`, holding any number
> of scene `*.json` files that share one `assets/` (`spec.md` §14.2).
>
> **Save target** — the pair `{ directory handle, filename }` the current scene is
> associated with (`spec.md` §14.5). There is **none** at boot, and it is never
> persisted across a reload.
>
> **Asset** — a file under the scene folder's `assets/` that a scene row references by a
> folder-relative `src`. Two kinds: a **mesh asset** (`.glb`, `.gltf`, `.ply`, `.obj` —
> triangles, measured against) and a **capture** (`.spz`, `.sog`, `.ply`, `.splat`,
> `.ksplat` — Gaussians, drawn only).
>
> **Dependency closure** — an asset plus every sibling file it references (`.bin`,
> `.mtl`, textures), transitively. Already defined by `geometry_assets.md` §10 as the
> unit a cross-folder Save As… copies; this feature makes it the unit an *import*
> assembles.
>
> **Pending asset** — an imported asset whose bytes exist only in this browser session:
> the row references it and the viewport draws it, but nothing has been written to disk
> yet. It becomes an ordinary asset at the next save (§8).
>
> **Materialise** — to write a pending asset's bytes into the save target's `assets/`.
> The word is used narrowly and only for that.

---

## 1. Problem & goal

Today a file gets into a scene in exactly one way: the user puts it in `assets/` with
Finder, and an in-app dialog lists what is there
(`gaussian_splats.md` §3.2, `geometry_assets.md` §3.2). That rule is stated three
times — `spec.md` §14.9 ("**nothing is ever written into `assets/`**"),
`gaussian_splats.md` §3.2, `geometry_assets.md` §14 — and it bought something real: a
`read`-mode folder handle, no quota surface, no copy progress, and one
multi-hundred-megabyte capture shared by every scene file in the folder.

What it costs is the first thirty seconds of every session. A model arrives in
Downloads. To use it the user leaves the app, finds the scene folder, finds `assets/`,
moves the file, returns, and opens a dialog to pick the thing they just moved. For a
`.gltf` they must also know that the `.bin` beside it is not optional. Nothing about
that sequence is a decision — it is a file-manager errand the app made them run because
the app declined to.

**Goal.** One route in, from anywhere on disk, for both kinds:

- An **Import** entry that opens the OS file picker directly — no in-app listing, no
  precondition that the file already be in the right place, and **no requirement that a
  scene folder exist yet**.
- **Dependency resolution** for the two formats that need it: a `.gltf` and an `.obj`
  are told what they are missing and asked for it by name.
- The bytes land in `assets/` **at the next save**, in a folder of their own, with
  collisions answered by the confirmation `spec.md` §14.5 already raises.

## 1.1 What this reverses, and what survives

This feature deletes the no-writing rule. It does **not** delete the reasoning behind
it, because the deferral in §8 keeps most of it standing:

- **Writing still happens only during a save.** `spec.md` §14.5's "Save As… is the one
  operation that copies asset bytes" becomes "a save is the one operation that copies
  asset bytes" — a smaller change than it looks. An import is a scene edit like any
  other: it changes what is on screen and marks the scene unsaved. Nothing reaches the
  disk until the user commits the scene to disk, which is the moment they already
  understand as "make this real".
- **The `read`-mode handle survives.** Load still grants `mode: 'read'` and write access
  is still requested lazily, from the save's own user activation (§8.1). Importing a
  model into a scene you are only looking at asks for nothing.
- **One `assets/`, shared, still.** A materialised asset is an ordinary asset: every
  other scene file in the folder can reference it, and the dedupe in §8.3 exists
  precisely so that re-importing the site's own model does not make a second copy of it.
- **What genuinely changes** is that the app now creates files, and — under one narrow,
  confirmed condition (§8.5) — removes them. That is new, it is the only irreversible
  thing the app does, and §8.6 is the guardrail it gets.

## 1.2 The listing goes away

`geometry_assets.md` §3.2's **Add Geometry** dialog and `gaussian_splats.md` §3.2's
**Add 3DGS** dialog are **replaced**, not extended. Both listed `assets/`; with a picker
that reaches anywhere, `assets/` is just another folder the picker can be pointed at,
and the `isSameEntry` dedupe (§8.3) makes picking a file that is already there behave
exactly as the listing did — no copy, a reference to the file in place.

What is lost is the browse-what-this-site-already-has view. That is a real loss and it
is accepted: the OS picker remembers the last folder, shows sizes and thumbnails, and
searches — everything the in-app list did, plus everything it did not. Re-adding an
in-app browser later is §16's business, not a reason to keep two dialogs answering the
same question with opposite rules.

Deleted with them: `scene/splatAssets.ts`, `ui/AddSplatDialog.tsx`, and
`sceneIO.listSplatAssets`.

---

## 2. The pipeline

Five steps, the same for both kinds. Only step 3 differs between them, and only because
captures are single-file.

| # | Step | Where | Fails how |
|---|---|---|---|
| 1 | **Pick** — the OS file picker, filtered to the kind's extensions | §3 | cancel is a silent no-op |
| 2 | **Sniff** — classify the bytes; refuse the wrong kind | §4 | refused in a dialog, nothing added |
| 3 | **Resolve** — scan the dependency closure, prompt for what is missing | §5 | required dep unsupplied ⇒ no commit |
| 4 | **Commit** — the row appears and draws, from memory | §6, §7 | — |
| 5 | **Materialise** — the next save writes the bytes into `assets/` | §8 | save aborts, nothing written |

Steps 1–4 are one user gesture on the clean path: pick a `.glb` and the row is there.

---

## 3. Pick

### 3.1 The entries

The hierarchy header **"+" menu** (`spec.md` §5.5) carries two import entries,
replacing **Geometry…** and **3D Gaussian Splat…**:

- **Import model…** — `.glb`, `.gltf`, `.ply`, `.obj`
- **Import 3DGS capture…** — `.spz`, `.sog`, `.ply`, `.splat`, `.ksplat`

The **Geometry** group header's context menu keeps its **Import model…** item, so an
empty geometry list still has a route out of itself (`geometry_assets.md` §2.3).

**Both entries are now always enabled.** The *"Load or save a scene first."* hint is
**deleted** from both: an import no longer needs a folder, because it no longer writes
one (§8). This removes the app's only conditionally-disabled "+" entries, which is a
simplification worth stating — every "+" entry spawns something, always.

**Two entries, not one.** A single **Import…** that sniffed the file and decided which
kind to create would remove the wrong-dialog error entirely, and it was rejected: `.ply`
is a legal member of both lists, so the user's choice of entry is the only thing that
distinguishes *"this point cloud is my site backdrop"* from *"this point cloud is a
mistake"* (§4.2). The menu entry is where the intent is stated.

### 3.2 The picker

`showOpenFilePicker` with `multiple: false`, a `types` entry naming the kind's
accepted extensions, and `excludeAcceptAllOption: false` — a user who knows their file
is fine can still reach it past a mis-detected extension, and §4 validates the bytes
regardless of how the file was reached.

The menu click is the **user activation** the picker requires, so the entry opens the
picker directly: no app dialog can precede it. Every dialog this feature shows is
therefore a *consequence* of a pick, which is also why there is no dialog at all on the
clean path (§6.1).

`startIn` is the save target's folder when one exists, so the commonest destination —
`assets/` in the folder already open — is one click away, and the picker's own
last-used-directory memory handles the rest. A **cancelled** picker is a silent no-op:
no dialog, no banner, nothing added.

### 3.3 There is no path, only a handle

`showOpenFilePicker` returns a `FileSystemFileHandle` with **no parent and no path**.
Three consequences run through the rest of this document, and none of them is a bug to
work around:

- **Siblings are unreachable.** A `.gltf`'s `.bin` cannot be read just because the
  `.gltf` was picked. Hence §5.
- **"Is this already in `assets/`?" is not a string comparison.** It is
  `FileSystemHandle.isSameEntry`, run against a walk of the folder. Hence §8.3.
- **The destination name is derived, not read.** `file.name` is all there is, so the
  folder an import lands in comes from that name (§6.2).

---

## 4. Sniff

The picked file is classified **before** anything is added, from bytes already in hand.
This moves two checks earlier than `geometry_assets.md` specified them: the PLY routing
(its §3.3) was a list annotation and is now a validation, and the zero-triangle refusal
(its §4.5) was a list annotation and is now a parse-time refusal. Both keep their
wording.

**Every reason quoted in this document is display copy, not the string the code
returns.** A pure function that composes user-facing text returns an **i18n key**
(`spec.md` §18.4, `ai/CONVENTIONS.md`) and the UI resolves it, so each refusal —
§4's and §8's alike — carries a key in both `en` and `zh-TW` (§13). The
exclusion for browser-originated text (a `DOMException`'s message, `spec.md`
§18.1) applies to *that* text only, never to a sentence this app wrote.

### 4.1 Extension

Case-insensitive, against the entry's list (§3.1). A file reached past the picker's
filter with an extension the kind does not accept is refused, naming the accepted set.

### 4.2 `.ply` routes by header

`.ply` is in **both** lists and a mesh PLY and a splat PLY are different files entirely.
They are distinguishable from the header alone — plain ASCII at the head of every PLY,
binary variants included, terminated by `end_header`:

| Header | **Import model…** | **Import 3DGS capture…** |
|---|---|---|
| has `element face`, no Gaussian properties | **accepted** | refused: *"that's a mesh PLY — use Import model"* |
| has Gaussian properties (`f_dc_0`, `scale_0`, `rot_0`, `opacity`) | refused: *"that's a 3DGS capture — use Import 3DGS capture"* | **accepted** |
| neither (vertices, no faces) | refused: *"no faces — nothing to occlude"* (`geometry_assets.md` §4.5) | **accepted** — Spark may still decode it |
| unreadable / not a PLY | refused: *"not a readable PLY"* | refused, same |

A refusal **names the other entry** and, unlike the old listing's version of this
message, that is now actionable: the other entry is enabled, opens a picker, and can be
pointed at the same file. This is the dead end §1.2's unification exists to remove.

The sniff is a pure function over the header text (`scene/plyHeader.ts`); `sceneIO`
reads the first **4 KB** and hands it over. 4 KB is comfortably past `end_header` in
every real file; a header that has not ended by then reports *"not a readable PLY"*
rather than reading further.

### 4.3 Zero triangles

A mesh asset that parses but yields no triangles — a faceless PLY, an OBJ of only points
or lines, a glTF whose nodes are all lights or cameras — is **refused at import**, with
`geometry_assets.md` §4.5's reason and §4.5's reasoning: it would occupy a row, occlude
nothing, and still grow the workspace AABB, diluting every coverage rate with voxels
nothing can cover.

This requires a **parse** rather than a sniff, so it happens after §5 assembles the
closure — a `.gltf` whose triangles live in its `.bin` cannot be judged without it. The
refusal therefore lands on the resolve dialog's commit, not on the pick. A hand-edited
scene file referencing such an asset still loads and badges the reason
(`geometry_assets.md` §9), unchanged.

### 4.4 A capture is not sniffed further

Beyond §4.2's PLY case and the `meta.json` refusal `gaussian_splats.md` §3.1 already
specifies (*"that's a SOG bundle — use its `.sog` zip instead"*), a capture is accepted
on its extension and decoded lazily by Spark, exactly as today. A capture that fails to
decode badges `⚠ could not be decoded` on its row, as it already does.

---

## 5. Resolve the dependency closure

### 5.1 What is scanned

`scene/assetDeps.ts` — the scanner `geometry_assets.md` §8 already specifies for
save-time copying — is reused verbatim at import time:

| Format | Dependencies |
|---|---|
| `.glb`, mesh `.ply`, every capture format | none — self-contained |
| `.gltf` | `buffers[].uri` + `images[].uri`, skipping `data:` URIs |
| `.obj` | every `mtllib` operand |
| `.mtl` (reached from an `.obj`) | every `map_*` / `bump` / `disp` / `refl` operand |

The scan is **transitive** and deduplicating: an `.obj` yields its `.mtl`, the supplied
`.mtl` is itself scanned for maps, and a texture named by two `.mtl`s is asked for once.
Each operand is resolved **relative to the referencing file** and validated by
`isSafeAssetPath` — an operand that is absolute, a URL, or escapes with `..` is
**rejected, not resolved**, and reported as unsatisfiable rather than prompted for.

That the app now has this scanner at import means the required **relative path** of every
dependency is known exactly: `textures/wall.png` is written inside the `.gltf`. The app
never guesses where a dependency goes. It only needs the **bytes**.

### 5.2 The resolve dialog

Shown only when the closure is non-empty **and** something in it is unsatisfied. One row
per missing dependency:

- the **required relative path**, as the referencing file spells it (`textures/wall.png`)
- what it is for — **Required** or **Optional** (§5.3)
- a **Choose…** button opening `showOpenFilePicker` for that one file, and — for an
  optional row — **Skip**
- once supplied, the chosen file's name and size, with a **basename mismatch warning**
  when the picked file is not named what the model asked for. A warning, not a refusal:
  a user who renamed a texture on disk knows better than the app does, and the bytes are
  written under the required path regardless.

A supplied `.mtl` is scanned on the spot (§5.1), so its own maps appear as new rows
beneath it. The dialog's commit is enabled when **every Required row is satisfied**;
Optional rows may be left unsupplied.

It is a **backdrop modal**, like every other dialog that settles a reference to a file
on disk (`spec.md` §14.7). **Escape** cancels the whole import; **Cancel** does the same.
Cancelling discards every file picked in the dialog and adds nothing.

### 5.3 Required versus Optional, and why the line falls there

The split is by **what the dependency does to the triangles**:

- **Required** — a `.gltf`'s `buffers[].uri`. Without it the asset has no triangles at
  all, so committing would produce a row that §4.3 refuses anyway. The refusal is moved
  to where it can be acted on.
- **Optional** — textures (`images[].uri`, `map_*`, `bump`, `disp`, `refl`) and the
  `.mtl` itself. Without them the model has every triangle it ever had and occludes
  **exactly** as correctly; it renders untextured. Since nothing this app computes reads
  a material, a missing texture cannot change a coverage number.

This is the app's existing line, applied to files: appearance is never load-bearing,
triangles always are. It is also the escape hatch — a site model shipping forty textures
where one is genuinely lost stays importable, and it would be absurd for a lost `.png`
to block a measurement it cannot influence.

A skipped optional dependency is **recorded on the row** as `⚠ N textures skipped` in
addition to whatever load badge `geometry_assets.md` §4.2 gives it, so the model's
appearance is explained rather than merely odd.

---

## 6. Commit

### 6.1 No dialog on the clean path

A self-contained file that passes §4 is added **immediately**: no confirmation, no
summary. The row appears, is **auto-selected**, and its panel opens on it — the
committed behavior `geometry_assets.md` §3.2 and `gaussian_splats.md` §3.2 already
specify, minus the list that preceded it.

A dialog appears only when there is something to **resolve** (§5.2) or to **refuse**
(§4), which is the general rule: this feature's UI is entirely made of consequences.

The entity created is exactly the one each kind's spec already defines — a
`MeshGeometryObject` or a `SplatObject`, next free id, `enabled: true`, identity
transform, blank name — with its `src` per §6.2. Loading starts immediately from memory
(§7.2). The add **marks the result stale** for a mesh (`geometry_assets.md` §1.1) and
**does not** for a capture (`gaussian_splats.md` §1.1), unchanged.

### 6.2 `src` is assigned now

Every import gets a folder of its own:

```
assets/<name>/<file>
assets/<name>/<dependency path…>
```

`<name>` is the picked file's basename **without its extension**, normalized by
`spec.md` §14.5's portability rule — trimmed, with `/ \ : * ? " < > |` and a leading `.`
replaced by `-` — falling back to `model` / `capture` if nothing survives. So
`rack.gltf` becomes `assets/rack/rack.gltf` with its texture at
`assets/rack/textures/wall.png`.

**One rule, including for self-contained files.** `assets/shelf/shelf.glb` and
`assets/site/site.spz` are a path segment longer than they need to be, and that is the
price of not branching the rule on whether a parse happened to find dependencies —
something the user cannot predict before picking. It also makes collisions structural:
two models that both ship `textures/wall.png` can never touch each other's files.

This **changes `gaussian_splats.md` §3.1's** "conventionally `assets/<file>`" for
*imported* captures. Hand-authored and previously-saved scene files referencing
`assets/site.spz` are unaffected — `isSafeAssetPath` accepts both shapes, and §8.3's
dedupe resolves a picked file to wherever it actually lives, not to where an import
would have put it.

**Within the pending set, names are made unique at import.** Two imports of two
different `rack.gltf`s in one session become `assets/rack/` and `assets/rack-2/`
immediately — the app can see its own pending set, so there is nothing to defer. Only
collisions with **disk** wait for the save (§8.4), because only those need a folder to
be readable.

---

## 7. The pending store

### 7.1 Model

The row carries its real `src` from the moment it is created; the bytes live beside the
scene:

```ts
/** src → the files to write when this asset is materialised (§8). */
type PendingAssets = Map<string, PendingAsset>;

interface PendingAsset {
  /** The picked file's bytes, read lazily when the save writes them. */
  file: File;
  /** The picker's handle for that file — what §8.3's `isSameEntry` compares. */
  handle: FileSystemFileHandle;
  /** Dependency path (relative to the scene folder root) → its picked File. */
  deps: Map<string, File>;
}
```

The **handle is held alongside the bytes** because a `File` answers no question
about identity: §8.3's dedupe is `FileSystemHandle.isSameEntry`, and the picker
hands the handle over exactly once. Stage C adds a `skipped: readonly string[]`
for §5.3's row note; until there is a resolve dialog to skip anything in, the
field would be written empty and read by nothing.

**`Scene` is untouched.** No nullable `src`, no new array, no new field — and therefore
no format change: `formatVersion` stays **4**, a pending mesh serializes exactly as a
resolved one, and the dirty check keeps working through the existing
`serializeScene` baseline comparison with no exclusion. A pending asset is invisible to
every consumer of the scene except the two that write it (§8) and draw it (§7.2).

The alternatives were both worse in the same way: a `src: string | null` makes `src`
nullable at every read site — the loader, `basename(src)` labels, `planAssetCopy`,
validation — to express a state that lasts until the next save; and a `pendingAssets`
array **inside** `Scene` puts non-serializable `File` handles inside the object that
gets JSON-serialized for the dirty check.

Keying by `src` is not arbitrary: it is the key `geometry_assets.md` §3.5's parse cache
and `gaussian_splats.md` §3.3's decode cache already use, so two rows on one pending
asset share one entry, one parse and one set of GPU buffers, exactly as two rows on a
resolved one do.

**`File` handles are lazy.** A `File` is a disk-backed `Blob`; forty of them cost
essentially no memory, which is what makes holding a whole closure until the next save
viable. The cost is **staleness**: a file moved or deleted on disk between import and
save can no longer be read. §8.2's pre-flight is where that is caught.

### 7.2 Drawing from memory

A pending asset loads through the same path as a resolved one, with one substitution:
the bytes come from the store instead of the folder handle.

- The asset itself is read from `pending.file`.
- `geometry_assets.md` §3.4's `LoadingManager.setURLModifier` — which resolves a
  requested relative URI against the referencing file's directory, validates it with
  `isSafeAssetPath`, and returns a blob URL — checks the **pending store first**, then
  the folder handle. So a half-resolved model (in `assets/rack/` only in memory) and a
  materialised one take the same code path, and a dedupe that resolves a pending asset
  onto an on-disk one (§8.3) needs no reload.
- Blob URLs are revoked once the parse settles, unchanged.

A pending asset is **not a load state**. It loads, draws, occludes, grows the AABB and
runs exactly as a resolved asset does; `runGate.ts` never mentions it. What is pending
is where the bytes *live*, not whether they are usable.

### 7.3 Lifecycle

- **Released** when the last row referencing that `src` is deleted — refcounted by
  referencing rows, alongside the parse/decode cache entry each kind's spec already
  releases there.
- **Dropped wholesale** on scene replacement (import), with the caches, from App's own
  signal rather than the loader's — the reasoning `geometry_assets.md` §3.5 and
  `gaussian_splats.md` §3.3 both give.
- **Cleared per entry** on successful materialisation (§8.7).
- **Never persisted.** A reload returns to the boot state with no target (`spec.md`
  §14.1), and a pending asset dies with the session. §9 is what makes that visible
  before it happens.

---

## 8. Materialise — the save

A save with pending assets does everything §14.5 already does, plus §8.2–§8.6 before it
writes the scene file. With no pending assets, nothing below runs and §14.5 is unchanged.

### 8.1 Write permission

`ensureWritePermission` (`mode: 'readwrite'`) from the save's own user activation, as
`spec.md` §14.5 already requires for every write. A denied request keeps the scene,
the target **and the pending store**, and reports in place — the import is not lost by a
save that never happened.

### 8.2 Pre-flight

Before anything is written or removed, every pending `File` in the plan is **probed**:
a one-byte read that fails means the source file was moved, renamed, deleted or
unmounted since the import.

The save **aborts naming the file**, writing nothing. This is deliberately checked up
front rather than discovered mid-write, because a stale handle is the single most likely
failure in this feature — the window between an import and a save is a whole working
session — and the alternative is discovering it after §8.5 has already emptied a folder.

### 8.3 Dedupe — the file may already be there

For each pending asset, walk the target's `assets/` recursively and compare each file to
the pending asset's own handle with `FileSystemHandle.isSameEntry`. A match means the
user picked a file that already lives in this scene folder.

On a match: **nothing is written**, the entry leaves the plan, and the row's `src` is
**rewritten to the matched file's folder-relative path** (its parse-cache entry is
re-keyed with it). Re-importing the site's own 300 MB capture costs a walk, not a copy.

This is identity, not a heuristic — correct even if the file was renamed on disk, and
never a false positive on two different `wall.png`s.

Two properties worth stating because they are not obvious:

- **A matched multi-file model resolves its siblings on disk.** The match is on the
  **primary** file; its dependencies are then reached relative to the on-disk copy by
  §3.4's URL modifier, exactly as they are for any other asset in `assets/`, and the
  pending dependency `File`s are discarded. If a sibling is genuinely absent there, the
  row badges `⚠ missing: <path>` — the normal failure, correctly reported, rather than a
  copy that papers over a folder the user believes is complete.
- **The walk runs at save, not at import**, because at import there may be no folder at
  all. So `src` can change between the row appearing and the save landing. That is the
  cost of one rule instead of two, and §8.7 reports it.

### 8.4 Collision

For each entry still in the plan, `assets/<name>/` may already exist in the target.
Collisions are **not resolved silently**: they join the count `spec.md` §14.5's
Save-as dialog already reports inline ("how many of this scene's referenced assets it
would replace", commit button reading **Replace**) and are gated by the same
**Overwrite confirmation**, which now names the folders as well as the files.

A **plain Save** raises that confirmation for the same reason it already does when the
target file exists: the write is destructive and irreversible.

**Nothing is renamed to avoid a collision.** Suffixing to the first free name would
never destroy anything, and it was rejected: it silently produces a second copy of a
model the user probably meant to replace, in a folder they cannot see from here. The
question is asked instead.

Cancelling the confirmation is a no-op: nothing written, nothing removed, the pending
store intact, the Save-as dialog still open with its typed name (`spec.md` §14.5).

### 8.5 Replace means replace

A confirmed collision **empties `assets/<name>/` recursively and then writes** the new
model into it. The folder afterwards holds exactly one model's files.

The alternative — write the new files, leave the rest — was rejected because it makes
"replace" a half-truth and leaves a folder holding two models' files interleaved, which
nothing afterwards can untangle: the app cannot tell an orphan from a dependency it
failed to notice.

This is the **only** irreversible operation in the app, and the only one that removes a
file from disk. §8.6 is the whole of its guardrail.

### 8.6 Guardrails on the removal

The removal is refused unless **all** of the following hold. They are checked before the
confirmation is raised, so the user is never asked to confirm something that will then be
refused:

- The target is a **direct child directory of `<target>/assets/`** — one path segment,
  validated by `isSafeAssetPath`, resolved through the target's directory handle.
- It is **not** `assets/` itself, **not** the folder root, **not** a multi-segment path,
  and **not** a plain file. `assets/rack` existing as a *file* refuses the import with
  that reason rather than removing it.
- Its name is **exactly** the resolved `<name>` from §6.2 — never a name derived at
  removal time, and never a prefix or glob match.
- **No surviving row resolves inside it.** If any other geometry or splat row in the
  scene being saved has a `src` under `assets/<name>/`, the save **aborts before
  writing anything**, naming the folder and the row. Replacing it would corrupt the very
  scene the user is saving, and no confirmation dialog should be able to authorise that.

The one residual risk this does not remove: a write that fails **after** a folder has
been emptied leaves that folder short of both models. §8.2 removes the likeliest cause
in advance; beyond that, folders are emptied **one at a time, immediately before that
folder's own files are written**, so a failure damages at most one, and the error names
it explicitly.

### 8.7 Order, and what the save reports

1. `ensureWritePermission` (§8.1).
2. Pre-flight every pending `File` (§8.2). Abort on any failure.
3. Dedupe against the target's `assets/`; rewrite matched `src`s (§8.3).
4. Compute collisions and check §8.6's guardrails. Abort on a self-reference.
5. Raise the overwrite confirmation if anything — scene file or asset folder — would be
   replaced (§8.4). Cancel is a no-op.
6. Per entry: empty its destination folder if colliding, then write its files.
7. Copy any **already-materialised** assets the save requires, which for a cross-folder
   Save As… is `planAssetCopy`'s existing dependency-closure copy, unchanged.
8. **Write the scene file last**, so a failed asset write never leaves a `*.json` on disk
   referencing bytes that are not there.
9. Clear the materialised entries from the pending store and update the target.

The status line (`spec.md` §14.7) reports the outcome, since a silent write needs an
acknowledgement, counting materialised folders alongside the assets a cross-folder
Save As… copied — **and, separately, how many imports were already in the folder**,
which is the one number that explains a `src` the save changed (§8.3). **Only §8.3 rewrites a `src`**: a collision does not suffix the
folder, it raises the confirmation and replaces (§8.4), so the only path that can
change under the user is one that resolved onto a file already on disk — and that is
a row now pointing at where its file actually lives, which is the correct outcome
rather than a surprise.

---

## 9. Unsaved work is now unrecoverable work

A pending import already marks the scene dirty: the row is a scene edit and `geometry`
and `splats` are both part of `serializeScene`. No new plumbing.

What changes is the **stakes**. A dirty scene has always been recoverable by redoing
edits; a discarded pending import loses bytes the app can no longer reach, assembled
through a dependency-resolution loop the user may not want to repeat. So:

- The **Load-anyway warning** (`spec.md` §14.4, §14.8) names them when there are any:
  *"Loading discards 2 imported assets that have not been written to disk."* The commit
  still reads **Load anyway**; nothing is blocked.
- The hierarchy row carries a **`not saved`** marker, distinct from and additional to
  `geometry_assets.md` §4.2's load badge — one says where the bytes are, the other says
  whether they parsed. It clears on materialisation.

**No `beforeunload` guard** is added. It would be a new app-wide behavior firing on every
ordinary unsaved edit, with wording the browser owns and this spec cannot state. The
in-app markers say the same thing where the app can say it properly.

---

## 10. Nothing is ever deleted on a row delete

Deleting a row whose asset was already materialised leaves the bytes in `assets/`,
always.

The folder is shared by **every scene file in it** (`spec.md` §14.2) — `night-shift.json`
may reference the very model `dense-96cam.json` just dropped — and the app sees only the
scene currently loaded. "Unused" is therefore a claim the app cannot make, and deleting
on a guess would silently break a sibling scene the user never opened.

So `spec.md` §14.9's no-file-management rule survives intact for **deletion** even as
this feature breaks it for **writing**, and the two halves are not inconsistent: the app
may create a file it knows the scene needs; it may not remove one whose absence it cannot
verify is safe. The §8.5 replace is the single exception, and it is confirmed, scoped,
and refused whenever the scene itself would notice (§8.6).

`assets/` accumulating unreferenced models is the accepted cost, cleared in the OS. A
folder-wide "remove unused assets" command is §16's business.

---

## 11. Error handling (`spec.md` §14.8)

Rows **added**:

| Case | Handling |
|---|---|
| Import picker cancelled | silent no-op; nothing added, no dialog, no banner |
| Picked file's extension not accepted by this entry | refused in a dialog naming the accepted set; nothing added |
| Mesh PLY picked in **Import 3DGS capture…**, or splat PLY in **Import model…** | refused, naming the **other entry** (§4.2); nothing added |
| PLY with neither faces nor Gaussian properties, picked as a model | refused: *"no faces — nothing to occlude"* (§4.3) |
| PLY header unreadable within 4 KB, or not a PLY | refused: *"not a readable PLY"* |
| Picked capture is a PCSOGS `meta.json` | refused: *"that's a SOG bundle — use its `.sog` zip instead"* (`gaussian_splats.md` §3.1) |
| Model parses to **zero triangles** after its closure resolves | refused at the resolve dialog's commit (§4.3); nothing added |
| A dependency operand is absolute, a URL, or escapes with `..` | listed as **unsatisfiable**, not prompted for; Required ⇒ no commit, Optional ⇒ treated as skipped |
| Required dependency (a `.gltf` buffer) not supplied | commit disabled, the reason stated inline; cancel discards the import |
| Optional dependency skipped | import succeeds; the row notes `⚠ N textures skipped` (§5.3) |
| Supplied dependency's basename differs from the required path | warning inline; the file is accepted and written under the **required** path |
| Resolve dialog cancelled | no-op; every file picked in it is discarded, nothing added |
| Save with pending assets, write permission denied | keep scene, target **and pending store**; error in place (§8.1) |
| A pending asset's source file moved / deleted / unmounted since import | save **aborts before writing anything**, naming the file (§8.2) |
| `assets/<name>/` exists as a **file**, not a directory | save aborts, naming it; nothing removed (§8.6) |
| `assets/<name>/` would be replaced, and another row in this scene resolves inside it | save **aborts before writing anything**, naming the folder and the row (§8.6) |
| `assets/<name>/` would be replaced, no row inside it | the **Overwrite confirmation** names it; confirming empties and writes, cancelling is a no-op (§8.4, §8.5) |
| Asset write fails (read, write, quota) after a folder was emptied | save aborts; scene file **not** written; error names the folder left incomplete (§8.6) |
| Picked file is already inside the target's `assets/` | no bytes written; `src` resolves to the existing path; reported in the status line (§8.3) |

Rows **deleted** (the conditions no longer exist):

| Case | Why |
|---|---|
| No `assets/` folder, or nothing addable in it | there is no listing to be empty |
| No save target yet (boot) — "+" entries disabled | imports no longer need a folder (§3.1) |

---

## 12. Terminology (`spec.md` §17)

- **Import** — bringing a file into a scene from anywhere on disk: pick, sniff, resolve,
  commit. Distinct from **Load**, which opens a *scene file*, and from **Add**, which is
  no longer a thing this app does to assets.
- **Pending asset** — an imported asset whose bytes exist only in this session. Draws,
  occludes and runs like any other; becomes ordinary at the next save.
- **Materialise** — to write a pending asset's bytes into the save target's `assets/`.
- **Dependency closure** — already defined by `geometry_assets.md` §10; this feature
  makes it the unit an import assembles, not only the unit a save copies.

---

## 13. Tests

Per repo policy every change ships with a test, and per `ai/CONVENTIONS.md` the boundary
sits where it already sits: every **judgement** is a pure module and is tested; the
File System Access calls stay thin and are verified by running the app.

Tested under `node --test`:

- **`classifyPlyHeader`** (`scene/plyHeader.ts`) — Gaussian properties ⇒ splat;
  `element face` ⇒ mesh; vertices with neither ⇒ point cloud; ASCII and
  `binary_little_endian`; CRLF line endings; no `end_header` within the window ⇒
  unreadable; non-PLY magic ⇒ unreadable.
- **`routePickedFile`** (`scene/assetImport.ts`) — the §4.2 matrix as a pure function of
  (entry kind, extension, PLY classification): each cell's accept/refuse and its exact
  reason string, including that a refusal names the *other* entry.
- **`scanAssetDependencies`** (`scene/assetDeps.ts`) — glTF yields `buffers[].uri` +
  `images[].uri` and skips `data:` URIs; `.obj` yields every `mtllib` operand (two on one
  line included); `.mtl` yields `map_Kd`/`map_Bump`/`bump`/`disp`/`refl`; paths resolve
  relative to the referencing file; `..`, absolute and URL operands are **rejected**, not
  resolved; `.glb`/`.ply`/capture formats yield nothing; a transitive
  `.obj → .mtl → texture` chain resolves fully and deduplicates.
- **`classifyDependency`** — buffers Required, images/`.mtl`/`map_*` Optional (§5.3);
  an unsatisfiable operand is neither prompted nor silently dropped.
- **`resolveImportName`** (`scene/assetImport.ts`) — basename minus extension; `spec.md`
  §14.5's rejected characters and a leading `.` replaced; empty result falls back to
  `model` / `capture`; **uniqueness within the pending set** (`rack`, `rack-2`, `rack-3`)
  and that it does **not** consult the disk.
- **`planMaterialisation`** (`scene/assetMaterialise.ts`) — the §8.7 plan as a pure
  function of (pending set, a listing of the target's `assets/`, the scene's other
  `src`s): which entries dedupe (given a set of matched handles), which collide, which
  folders would be emptied, and which `src` rewrites result. Asserts §8.6 in full — a
  plan targeting `assets/` itself, a multi-segment path, a name that is a prefix of the
  real one, or a folder holding a surviving row's `src` is **refused**, not emptied.
- **`planAssetCopy`** — unchanged behavior asserted against the new path shape:
  multi-segment `src`s under `assets/<name>/`, a dependency closure inside one, and a
  texture shared by two `.mtl`s copied once.
- **`pendingStore`** — refcounted by referencing rows; a second row on one `src` shares
  the entry; deleting the last row releases it; scene replacement clears all; a
  materialised entry clears and its parse-cache key is re-keyed on an §8.3 rewrite.
- **`serializeScene` / `parseSceneFile`** — a scene holding pending assets serializes
  **identically** to one whose assets are on disk, and `formatVersion` stays 4 (the
  regression guard for §7.1's central claim).
- **`rewriteAssetSrcs`** (`scene/sceneReducer.ts`) — an §8.3 rewrite re-points every mesh
  and splat row that moved, leaves the rest alone, is identity on an empty map, and
  **never marks the result stale** (the bytes did not change, only the name they are
  filed under).
- **`unsavedWarningText`** — names pending imports when there are any and reads as today
  when there are none (§9).
- **`describeSceneFileStatus`** — the save's status line counts materialised folders,
  and reports assets that were **already in the folder** when §8.3's dedupe resolved
  onto them, so a `src` that changed under the user is never silent (§8.7).
- **`runBlocker`** — a pending mesh does **not** block a run (§7.2), while a failed or
  loading one still does (`geometry_assets.md` §5.4). The regression guard on
  "pending is not a load state".
- **i18n parity** — every new key in both `en` and `zh-TW`, via the existing
  `localeParity` suite.

Deleted with their modules: the `planSplatAssetList` / `firstSelectableAsset` suites, and
`planGeometryAssetList` (never built).

Deliberately not unit-tested, and kept thin: the picker calls, the `isSameEntry` walk,
the recursive empty, and the write loop in `sceneIO`. Every decision they would otherwise
make is one of the pure functions above; what remains is I/O.

---

## 14. Edits required elsewhere (consistency)

### `spec.md`

| Section | Edit |
|---|---|
| §2.2 Layout / file map | Add `scene/assetImport.ts`, `scene/plyHeader.ts`, `scene/assetDeps.ts`, `scene/assetMaterialise.ts`, `scene/pendingAssets.ts`, `ui/ImportRefusalDialog.tsx`. **Remove** `scene/splatAssets.ts` and `ui/AddSplatDialog.tsx`. |
| §5.5 Hierarchy | Replace the "+" entries **Geometry…** and **3D Gaussian Splat…** with **Import model…** and **Import 3DGS capture…**; both **always enabled**; delete the conditionally-disabled entry rule and its hint. The Geometry group menu's item becomes **Import model…**. Add the row's `not saved` marker (§9). |
| §14.2 Folder layout | `assets/` holds **one subfolder per imported asset** (`assets/<name>/…`); a `src` may be multi-segment; a flat `assets/<file>` remains valid and is what a hand-placed file keeps. Update the sketch. |
| §14.4 Import (Load) | The unsaved-changes warning names pending imports (§9). Scene replacement drops the pending store with the caches. |
| §14.5 Export (Save / Save As…) | "Save As… is the one operation that copies asset bytes" becomes "**a save** is the one operation that writes asset bytes". Add §8's steps to both write paths: pre-flight, dedupe, collision, the confirmed folder replace and its guardrails, scene file written **last**. The confirmation and the inline warning now count **asset folders** as well as files. The status line gains the written / already-present / rewritten-`src` report (§8.7). |
| §14.7 UI controls | Replace the **Add 3DGS** dialog entry with the **Resolve dependencies** dialog (§5.2) — shown only when a closure is unsatisfied — and note that the import entries open the **OS picker** directly, with no app dialog before it. The Overwrite confirmation's card now names folders. |
| §14.8 Error handling | Apply §11 — both the added and the deleted rows. |
| §14.9 Out of scope | **Delete** "nothing is ever written into `assets/`" and the sentence excluding copying. Replace with what remains out of scope: **no deletion** of assets on a row delete (§10), no renaming/duplicating/deleting of *scene files*, no transcoding or conversion, no embedding/bundling. Keep the rest. |
| §17 Terminology | Add **import**, **pending asset**, **materialise** (§12); amend entries that say a file is "dropped in by the user". |

### `geometry_assets.md`

| Section | Edit |
|---|---|
| §3.2 Add Geometry dialog | **Replaced** by this document's §3–§6; the section becomes a pointer. The recursive `assets/` listing, its progress state and its no-depth-cap rule go with it. |
| §3.3 `.ply` routing | **Moves** here as §4.2, reframed from list annotation to validation. The table's outcomes are unchanged. |
| §3.4 Sibling resolution | **Kept**, with one addition: the URL modifier checks the **pending store** before the folder handle (§7.2). |
| §3.5 One parse per `src` | Add that the cache is **re-keyed** when §8.3 or §8.4 rewrites a `src`. |
| §4.5 Zero-triangle refusal | The refusal moves from "the Add Geometry dialog" to "import commit" (§4.3); the reasoning and the badge for a hand-edited file are unchanged. |
| §9 Error handling | Drop the "No `assets/`, or nothing addable" and "No save target yet" rows; the rest stands. |
| §13 Stages | Restage per §15 below. |
| §14 Out of scope | **Delete** the "Writing into `assets/`" bullet. |

### `gaussian_splats.md`

| Section | Edit |
|---|---|
| §3.1 Path resolution | "Conventionally `assets/<file>`" becomes: a hand-placed capture is `assets/<file>`, an **imported** one is `assets/<name>/<file>` (§6.2); both are valid and resolve identically. |
| §3.2 Add 3DGS dialog | **Replaced** by this document; the section becomes a pointer. `splatAssets.ts` and `AddSplatDialog.tsx` are deleted. |
| §3.3 One decode per `src` | Add the re-key rule, as for the parse cache. |
| §9 Error handling | Drop the two dialog rows; the `meta.json` refusal moves to the picker (§4.4). |
| §13 Out of scope | Note that import now covers captures, so "the user drops the file in" no longer describes the only route. |

### `ai/` docs

| Doc | Edit |
|---|---|
| `DESIGN.md` | The shift: the app stopped requiring the user to stage files for it. A site model goes from Downloads to measured coverage without leaving the window. |
| `ARCHITECTURE.md` | The import pipeline (picker → sniff → deps → reducer → pending store → loader), the pending store's place beside the parse/decode caches, and the save path's new pre-flight/dedupe/materialise phases. |
| `DECISIONS.md` | New entries, newest at top: **the picker replaces both listings**; **every import defers to the save**, keeping writes inside the one operation that already wrote; **`src` assigned at import with bytes in a store keyed by it**, so `Scene` and `formatVersion` are untouched; **one subfolder per import**, uniform even for single-file assets; **`isSameEntry` dedupe at save** over name matching; **Required/Optional dependencies split by effect on triangles**; **replace means empty-then-write**, with the four guardrails and the self-reference refusal; **no deletion on row delete**, because `assets/` is shared across scene files. |
| `CONVENTIONS.md` | The rule that a format sniff is a pure function over bytes already read; that a multi-step plan over the file system (§8.7) is computed as a pure function of a listing and asserted whole, with the I/O left thin. |
| `STACK.md` | `showOpenFilePicker`, `FileSystemHandle.isSameEntry`, `FileSystemDirectoryHandle.removeEntry({ recursive: true })` — no new dependency. |
| `VISUAL_DESIGN.md` | The Resolve-dependencies dialog (rows, Required/Optional, Choose…/Skip, the mismatch warning), the row's `not saved` marker and skipped-textures note, and the Overwrite confirmation's folder wording. |
| `WORKFLOWS.md` | Bringing a real site model in: Import model…, resolve what it asks for, fix up-axis/units in the panel, Save to write it into `assets/`, Run. |

---

## 15. Implementation stages

`geometry_assets.md` §13's stage 1 has shipped. Its stages 2 and 3 are restaged here,
since this document now owns the adding half of stage 2.

| Stage | Contents | Green when |
|---|---|---|
| **A. Import, self-contained** ✅ | The two "+" entries and the picker (§3); the sniff and its refusals (§4.1–§4.4, `plyHeader.ts`, `routePickedFile`); `resolveImportName`; the pending store (§7) and drawing from it; the `mesh` loader table for `.glb` / mesh `.ply`; the `not saved` marker. **No dependency resolution, no writing** — a pending asset was session-only, and a save with one was refused until stage B. | `.glb` and mesh `.ply` import from anywhere and render; both listings deleted |
| **B. Materialise** ✅ | §8 end to end: pre-flight, `isSameEntry` dedupe, `planMaterialisation`, collision into the existing confirmation, the guarded folder replace, scene-file-last ordering, the status line, §9's warnings. | an imported `.glb` survives a save, a reload and a re-load; every §8.6 refusal is asserted |
| **C. Multi-file** | §5 in full — `assetDeps.ts` at import, the resolve dialog, Required/Optional, transitive `.mtl` scanning, the skipped-textures note; `.gltf` and `.obj` loaders; §3.4's sibling resolution including the pending-store lookup; `planAssetCopy` over the new path shape. | a `.gltf` + `.bin` + textures and an `.obj` + `.mtl` + maps import, render and survive a cross-folder Save As… |

`geometry_assets.md` §13 stage 3's remaining items — the up-axis / unit presets, the size
readout, the triangle guardrail and its stats-panel readout — are **independent of this
document** and stay there, as a stage D.

---

## 16. Out of scope / future

- **An in-app asset browser.** §1.2 removes the listing; a *"what does this site already
  have?"* view is a legitimate thing to want back, but it is a browser over `assets/`,
  not an add dialog, and it should be built as one.
- **Removing unused assets.** §10 declines to guess. A folder-wide command that reads
  every `*.json` in the folder, unions their `src`s and offers to delete the remainder is
  the honest version, and it is its own feature with its own failure modes — an
  unparseable scene file in the folder would make everything look unreferenced.
- **Importing a folder.** `showDirectoryPicker` as a second import route, which would
  make a multi-file model one gesture instead of a resolve loop. Declined for now
  because it grants the app read access to a whole tree to copy a handful of files from
  it, and §5's loop is exact about what it takes.
- **Drag-and-drop onto the viewport**, via `DataTransferItem.getAsFileSystemHandle()`.
  The obvious next gesture, and it reuses this entire pipeline from step 2 onward.
- **Transcoding or conversion** — `.obj` to `.glb`, texture recompression, Draco. The
  app writes the bytes it was given.
- **Progress for a large copy.** §8 writes with no per-file progress; a multi-gigabyte
  capture will make a save sit. The status line reports the outcome, not the journey.
- **Undo** — unchanged (`spec.md` §5.5.1). A mis-import is deleted; a materialised asset
  is removed in the OS.
- **Non-Chromium browsers** — unchanged; `showOpenFilePicker` is part of the same File
  System Access API the scene folder already needs.
