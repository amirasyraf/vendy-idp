---
name: Vendy
description: A light-only Backstage developer platform whose VM build pipeline is a transit line.
colors:
  ink: '#111316'
  mute: '#5D636B'
  faint: '#8A9098'
  rule: '#E3E5E8'
  surface: '#F3F4F5'
  white: '#FFFFFF'
  blue: '#0B5FD3'
  blueDark: '#0A4FB0'
  green: '#00935A'
  red: '#E8402E'
  redText: '#C2321F'
  grey: '#9AA0A7'
  track: '#D5D8DC'
  station-border: '#C9CDD2'
  bui-border-2: '#d2d5d9'
  retired-label: '#B0B5BB'
  failed-row: '#FEF6F5'
  warning: '#B26B00'
typography:
  regular:
    fontFamily: '"Schibsted Grotesk Variable", "Schibsted Grotesk", system-ui, sans-serif'
  page-title:
    fontSize: '32px'
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: '-0.025em'
  backstage-title:
    fontSize: '30px'
    fontWeight: 700
    letterSpacing: '-0.025em'
  card-title:
    fontSize: '18px'
    fontWeight: 700
  table-heading:
    fontSize: '11px'
    fontWeight: 600
    letterSpacing: '0.07em'
  ssh-command:
    fontFamily: '"JetBrains Mono", ui-monospace, Menlo, monospace'
  station-small:
    fontSize: '10.5px'
    lineHeight: 1.3
  station-large:
    fontSize: '12.5px'
    lineHeight: 1.3
rounded:
  chip: '4px'
  control: '6px'
  paper: '8px'
components:
  button-primary:
    backgroundColor: '{colors.blue}'
    textColor: '{colors.white}'
    rounded: '{rounded.control}'
  button-primary-hover:
    backgroundColor: '{colors.blueDark}'
  button-secondary:
    backgroundColor: '{colors.white}'
    textColor: '{colors.ink}'
    rounded: '{rounded.control}'
  software-chip:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.ink}'
    rounded: '{rounded.chip}'
  search-trigger:
    backgroundColor: '{colors.surface}'
    textColor: '{colors.mute}'
    rounded: '{rounded.control}'
    height: '34px'
---

# Design System: Vendy

## Overview

**Creative North Star: "Line Diagram"**

The VM build pipeline is a transit line and each VM is a train on it. The owned
operating surfaces make position, failure and the next action readable together,
rather than substituting a status badge and generic progress bar for the pipeline.
White ground, pale utility surfaces, ink rules and blue travelled track keep the
interface direct and operational. There are no gradient page banners or dark
sidebar in the implemented shell.

This is an implementation reference, not a redesign proposal. It captures the
source-defined system in `src/theme/`, the home/navigation/catalog overrides and
`../../plugins/vm-status/src/`. Product intent lives in `PRODUCT.md`; the selected
direction lives in `.impeccable/surfaces/src-app-tsx.md`. Existing Backstage plugin
surfaces remain visible and do not all use the transit-line grammar.

**Key Characteristics:**

- A shared run-specific stage line on the Virtual Machines product page, VM-only Resources lists,
  VM detail and run pages.
- Dense, legible operational information with explicit state text and next actions.
- Flat white surfaces, light dividers, restrained rounding and state-bearing colour.
- Light-only, applied through supported Backstage extensions and unified theming.

This document records the source-defined system. Local fixture screenshots and
browser smoke cover the run and entity presentation at desktop/mobile widths;
they do not establish accessibility conformance, deployed behavior or real-workflow success.

## Colors

The palette is neutral first, with one interaction/track accent and distinct
semantic state colours. Frontmatter records actual values, not a newly invented
palette; `cf` and `vmColors` currently duplicate several values in code.

### Primary

- **Line blue (`blue`)**: primary actions, links, selected navigation underlines,
  completed/travelled track, current station, focus outline and input caret. BUI
  solid backgrounds and rings use the same blue.
- **Deep line blue (`blueDark`)**: theme link/button hover and most owned primary
  action hovers. The Resources Launch button is an exception: its local hover
  is `#0A52B8`, not the shared deep-blue value.

### Semantic

- **Ready green (`green`)**: ready VM bullets/state markers and the VM product page's refresh
  indicator. Completed pipeline stations stay blue, not green. Workflow task job
  success text separately uses the theme success green.
- **Failure red (`red`)**: failed VM bullets, crossed failure station and the product page's
  filled failed-row View Run action.
- **Failure text (`redText`)**: failed station labels, error/status copy and the
  outlined Destroy VM action; also the hover of the product page's filled red action.
- **Retirement grey (`grey`)**: destroying and other/unknown VM markers.
- **Warning amber (`warning`)**: theme warning role, not a sixth VM state.

### Neutral

- **Ink (`ink`)**: titles, primary text, avatar ground and the count strip's top rule.
- **Muted (`mute`)**: secondary text, metadata, inactive navigation and large-line
  default labels. **Faint (`faint`)**: small waiting/skipped labels.
- **White (`white`)**: application/paper backgrounds and station centres.
- **Utility surface (`surface`)**: table headings, software chips, search trigger
  and SSH command background.
- **Rule (`rule`)**: ordinary dividers, card outlines and control borders.
  **BUI secondary border (`bui-border-2`)** is the stronger BUI border token.
- **Untravelled track (`track`)**, **station border (`station-border`)** and
  **retired label (`retired-label`)** distinguish waiting geometry and retired
  lines. Station-border grey is also used for several control hover borders.
- **Failure wash (`failed-row`)**: Virtual Machines product-page failed rows only.

**The Track Is Not Readiness Rule.** Blue records pipeline traversal; green
identifies a ready VM. Skipped stages can carry blue track without being completed
work.

## Typography

**Display and body:** Schibsted Grotesk Variable, then Schibsted Grotesk,
`system-ui`, `sans-serif`. The app entry imports the variable font locally via
Fontsource. **Command face:** JetBrains Mono (imported at weights 400 and 500),
with system monospace fallbacks.

- **Page titles:** the frontmatter page-title role is shared by the home greeting,
  Resources heading and VM name. The home greeting is 32px/700, not an oversized
  marketing headline, and uses balanced text wrapping.
- **Stock page titles:** the theme's Backstage header uses the backstage-title
  role; InfoCard headings use card-title. The MUI h5 override is 15px/700 with
  slight negative tracking; sign-in locally overrides its h1 to 24px with
  `-0.015em` tracking.
- **Operational copy:** owned descriptions commonly use 14px, metadata 13–13.5px,
  detail/status notes 12–12.5px. Inherited plugin body typography is not replaced
  by a separately defined complete size scale.
- **Labels:** use Title Case for owned headings, cards, tabs and actions; keep prose and status
  sentences in sentence case and preserve brand names. The VM product table headings are visually
  uppercase. Its status counts are 26px/700, reducing to 20px on narrow screens.
- **Stations:** small and large roles differ in label size and top spacing, not
  station geometry. Current and failed labels are bold (700).

**The Command Face Rule.** In the owned VM content, use JetBrains Mono for
the full `ssh user@ip` command, not standalone IPs, names or general metadata.
The VM access facts render the IP in the regular face. Global CSS also assigns
mono to `code`, `pre`, `kbd` and BUI's monospace token, so inherited code/log
surfaces are not guaranteed to be SSH-only.

**The Aligned Numerals Rule.** Tabular numerals are scoped by global CSS to
`table` and `time`, not the entire application. Do not apply them globally to
Schibsted Grotesk; they also change punctuation widths. Existing timestamp text
outside those elements does not automatically receive tabular numerals. Backstage
key/value metadata tables (template review step, metadata cards) opt back out to
normal numerals, and their label column shrinks to its text so each value sits
beside its label.

## Layout

The signed-in shell is a full-height (`100vh`) white flex column. A non-shrinking
top bar (56px) sits above a separately vertically scrollable content area. It is
not a sidebar and is not implemented as an overlay on the page.

Home centers within a 1056px canvas, with `44px 28px 64px` padding on desktop and the standard mobile
gutters. Resources and Virtual Machines fill the available width with `32px 20px 48px` page padding.
Their headers wrap. The Virtual Machines page adds a full-width
Demo Mode panel below its header; the status strip starts 28px below the panel. These are observed measurements, not a new universal
spacing-token scale. Owned surfaces commonly use 8/12/16/20/24px intervals, but
also intentional 10/14/28px gaps; do not claim a strict grid for every measurement.

The VM header uses `20px 20px 0` padding. Content and information cards stack with
24px gaps; where info cards exist, a wide-screen two-column layout gives content
twice the info-column width. Access/configuration facts use auto-filling columns
with a 180px minimum and `12px 24px` gaps.
Standalone run pages use a focused, fluid 1120px maximum-width canvas, with 20px
gutters (16px on mobile). Run headings, links, status and actions wrap rather than
expanding the page. Entity facts can shrink below 180px on narrow cards.

### Implemented responsive boundaries

| Boundary           | Actual effect                                                                                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| At or below 600px  | Pipeline labels are visually hidden except running/retrying/failed stations; columns follow the run's stage list.                                                                                                                  |
| At or below 760px  | Home/Resources/Virtual Machines padding becomes `24px 16px 40px`; VM status counts shrink. Top bar tightens padding/gaps, hides the brand wordmark, Search navigation tab and duplicate settings icon; avatar settings access and search trigger remain. |
| At or below 1000px | VM product table header disappears; each VM becomes a stacked block, pipeline width becomes fluid, and the action aligns left. |
| At or below 1100px | Top-bar search trigger becomes a 34px icon square and profile name/team text disappears.                                                                                                                                           |
| At or above 1100px | VM content with info cards uses a `2fr / 1fr` split. Exactly 1100px also meets the top-bar compact rule above.                                                                                                                     |

Above its stacking breakpoint, the VM product table has a 1080px minimum width and an
overflow wrapper; its pipeline is 520px wide. The Resources pipeline cell stays
300px wide and uses the stock catalog table rather than the VM product page's stacked-row
implementation. Settings uses MUI `xs={12}` / `md={6}` columns, retaining the
framework breakpoint rather than one of these owned media queries.

## Elevation & Depth

Owned surfaces are flat and divided by rules, not floating panels. Theme Paper
elevation levels 1 and 2 remove shadows and add a one-pixel rule; Cards also remove
shadows and carry that outline. Buttons disable elevation. This is not a global
assertion that every upstream modal, tooltip or higher Paper elevation is
shadowless: those are not all overridden.

Attention effects are meaningful, not ambient depth: the current station pulses
with a white-separated blue halo over 2.4 seconds using
`cubic-bezier(0.16, 1, 0.3, 1)`. Reduced-motion preference disables that animation.
The VM product page's green refresh dot has a static translucent halo. Owned page buttons and
navigation use short 160ms ease-out colour/border/background transitions.

## Shapes

Controls and command blocks use the control radius; theme rounded Paper uses the
paper radius, and chips use the smaller chip radius. The selected direction's
6px shorthand is therefore not a universal radius in implementation. Ordinary
dividers are one pixel; the VM product count strip starts with a two-pixel ink rule;
selected navigation/filter underlines are three pixels.

The signature geometry is circular size bullets and station stops joined by a
horizontal line. VM product-page size bullets are 34px; VM-header bullets are 40px. They carry
the first character of the requested size, or `?` when unavailable, in white
heavy type (800). Finalize is a squared terminus cap with a small 3px corner
radius, deliberately distinct from the circular preceding stations. Skipped
stops are ticks, not smaller dots or completed stops.

## Components

### PipelineLine: shared transit grammar

An ordered list, labelled "Pipeline stages", distributes the run's ordered stages equally.
Provision has eight stations: ServiceNow request → Register → Provision → Baseline → Software → AD join → Access → Finalize.
Modify shows Configure, Provision, Software and AD join (each skipped when unchanged) and Finalize;
re-apply shows Baseline, Software, AD join, Access and Finalize; power and OS-update runs are a
single station (Start, Stop, Reboot or OS update); destroy shows Destroy and Finalize. Skipped not-applicable stages remain visible. Bake is not a station.

Each station owns its arriving segment; the first has none. Geometry communicates
the process status:

| Process status                                 | Station and arriving track                                                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pending` / Waiting                            | White-centred 12px stop with a 2px neutral border; 2px neutral track.                                                                                      |
| `success` / Completed                          | White-centred 12px stop with a 3px blue border; 5px blue track; ink label.                                                                                 |
| `running` / In progress, `retrying` / Retrying | 16px white-centred stop with a 4px blue border, animated halo, bold blue label and 5px blue arriving track.                                                |
| `failed` / Failed                              | 16px filled red stop with a white cross, bold failure-text label; arriving track stays 5px blue.                                                           |
| `skipped` / Skipped                            | A 2px-wide, 13px-high blue non-stop tick with an italic faint label and 5px blue track. Tooltip says "Skipped (not applied)".                              |
| `cancelled` / Cancelled                        | Neutral stop and track; explicit cancelled text.                                                                                                           |
| `retired` presentation                         | Overrides all process variants: grey 5px track, neutral outlined stops and retired labels. Used for destroying VMs, not evidence of completed destruction. |

The last station keeps its small-radius cap rule, including if its status changes;
the skipped variant still supplies tick dimensions. Small lines reserve 22px above the label;
large lines reserve 26px. Dot and track dimensions are identical at both sizes.
The line and each grid station explicitly shrink to their container; labels truncate
within their station even on mobile (10px labels), so the last stop cannot be pushed off-card.
Large is used by the VM card, small by Virtual Machines and Resources. Labels ellipsize rather
than wrapping. Resources always requests screen-reader-only labels; VM product and detail labels
follow the 600px rule. Each item retains a text status and title tooltip.

The model reads `RunView.stages` from the authenticated `vms` API. No stage annotation
parsing or inferred completion remains. Home (when the VM panel is open and populated), Virtual Machines and Resources each issue one `/summary`
request, join by VM name and refresh about every five seconds (including terminal
summaries, to discover newly created runs). Without a known run they show coarse
`cf/status` and "No run known", not fabricated stage observations. Summary failures
surface an error and fall back to catalog state.

### VM state vocabulary

Overall VM state and process state are separate concepts:

| VM state     | Source `cf/status`         | Display / marker                                                                                                                          |
| ------------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`      | `ready`                    | Ready; green.                                                                                                                             |
| `building`   | `provisioning` or `frying` | Building · running station, or Building; Provisioning when provisioning has no running station; blue. Product filter calls this In Progress. |
| `failed`     | `failed`                   | Failed at the first failed station, otherwise Failed; red marker and darker red text.                                                     |
| `destroying` | `destroying`               | Destroying; grey marker and retired line.                                                                                                 |
| `stopped`    | `ready` + health check `stopped` | Stopped; grey. Product filter Stopped. A `ready` VM with a running instance reads Running; one with no instance, Instance not found (red). |
| `other`      | Anything else or absent    | Capitalized raw status, otherwise Unknown; grey. No dedicated product filter. |

Attention helpers choose the first failed stage before a running/retrying stage.
A known active or failed run takes precedence over coarse catalog status. The shared
`vmRunLabel` names the operation on Home, Virtual Machines, Resources and the VM header: provision is
Building · <stage>, modify is Modifying · <stage>, re-apply is Re-applying configuration
· <stage>, power runs are Starting / Stopping / Rebooting, OS updates Updating OS, destroy is
Destroying. A retrying stage adds · retrying. A failed run names Failed at <stage> (power and
OS update: Stop failed, OS update failed…), or Needs attention when the failed stage is not
known. After a successful or cancelled day-2 run the label comes from the health check
(Running, Running · status checks failing, Stopped, Stopping, Starting, Instance not found),
or Ready when no health check is available; cancelled provision/destroy runs name the
cancelled operation. Destroyed is never inferred from
success alone. Color/filter state remains separate from this human wording.

### Buttons, fields and browser surfaces

Primary owned actions are blue with white text; secondary actions are white,
outlined and ink-labelled. Resources and Virtual Machines header actions are 40px high with 16px
horizontal padding; VM product-page row actions are 34px high with 12px padding; VM-card
actions are 36px high with 14px padding. Button labels use weight 600 without
automatic uppercase. Hover darkens primary backgrounds or strengthens outlines.

MUI TextFields default to outlined. Other form control/error/disabled behaviours
remain framework-owned unless locally set. Global keyboard focus is a 2px blue
outline with 2px offset; text selection uses translucent blue, search highlights
use a lighter blue wash, and links have a 3px underline offset. Thin neutral
scrollbars and blue input carets complete the browser surface treatment. These
rules do not establish a verified contrast/accessibility conformance claim.

### Home

A pale-blue welcome panel pairs the greeting and **Launch a Product** with a decorative transit
map. **Your Resources** groups the visible catalog into product panels. Each is collapsed by default,
with an icon, product name and resource count. Open a panel via its heading button to reveal a
linked list and the product-page shortcut. A VM row shows platform and state as chips; there is no
pipeline or SSH action on Home. Unknown types go to **Other Resources**. On mobile, row metadata
wraps under the resource name, and the product heading drops its description. **Browse All Resources**
opens the searchable inventory.

### Virtual Machines

The **Compute → Virtual Machines** product page owns VM operations across clouds: **Launch a Virtual
Machine**, **Get SSH Certificate**, Demo Mode and a status filter strip (All, In Progress, Ready,
Stopped, Failed, Destroying). Selected counts have a blue underline. A refresh note sits above the
table; errors, loading, no-VM and empty-filter states have explicit copy and actions.

Rows show size bullet/name/state, pipeline, details/software chips, **Activity time**
and one next action. Activity time is Ready since <absolute date/time> from
`cf/ready-at`, otherwise Requested <absolute date/time> from `cf/requested-at`.
Missing/invalid times say Request time unavailable; no run age is substituted for
VM request age. Resources has the same Activity time column, and the VM card uses
the same component. Failed rows sort first, then building, ready, other,
destroying, with name sorting within each group. Ready links to the certificate
template; building/failed link to View run only when a run URL exists. No action
is fabricated when unavailable. Run links go to `/vms/runs/<id>`. Home and the VM product page poll
the catalog about every 10 seconds.
Team scoping is enforced by the existing catalog permission policy, not a local
team-only filter; administrators can see all VMs.

### Navigation, Resources and VM pages

The top bar combines a three-station blue SVG mark and wordmark, Home / Resources /
Launch / Search links, a button opening the stock search modal, settings and an
initials avatar. The apparent search field is a trigger, not an inline text input.
Active navigation has an ink label and blue underline. Avatar access goes to
settings, including when the separate settings icon is hidden.

Launch is a card flow with a 32px title, muted subtitle and linked step trail. Virtual Machines and
Containers both start with Product Type › Product › Platform. Containers offers AWS and Azure and
opens Configure directly, where the platform is shown with a **Change Platform** link. Virtual
Machines continues through Image before Configure. Its platform cards use provider names without
OS copy; vSphere is marked **Coming Soon**. Each image card represents one configured OS release.
Cards stay disabled while availability is checked and are greyed out with **Not available** when the cloud image isn't ready
or cannot be verified. A sole configured image is preselected only when it's available. The picker
refreshes availability while open; **Continue** opens the form only for an available selection.
**Change** returns to the selected image if it is still available.

Resources owns its title/action shell but composes stock catalog filters, table,
search, sorting and pagination. Resource lists add Product; nonempty all-VM results also show
State, Pipeline and Activity Time. Mixed results keep the stock columns alongside Product.
Normal users' kind UI is restricted to
Resource; admins retain the full picker. This is not a new API security boundary.

VM pages replace the entity header with Resources and Virtual Machines breadcrumbs, VM name, a state pill
(dot + live label), favourite star, the day-2 action bar (Start or Stop, Reboot, Modify,
and a ⋯ menu with Apply OS updates, Re-apply configuration and red Destroy VM), and a meta
line with team, OS/platform and size. Every action except Modify opens a confirm dialog;
Destroy requires typing the VM name. While a run is active, the provision is unfinished or
no instance exists, only Destroy is enabled (disabled buttons say why in a tooltip); a
  stopped VM disables Reboot, Modify, OS updates and Re-apply ("Start the VM first").
  A transitioning VM can still show some of these controls; the API rejects operations that
  need a running VM when its observation is fresh. The OS-update confirmation currently says
  Ubuntu even on Windows; the selected stage uses the correct guest updater.
Section tabs appear only when there is more than one; otherwise a spacer is used.
The stock About card is hidden only for VMs. The header and body share one poller per VM
(`vmLive.ts`): the last 10 runs (`/runs?name=<vm>&limit=10`, every five seconds), the
health check (`/observed/<vm>`, every 15 seconds) and the catalog entity (every ten seconds,
to follow Modify and discover destruction). The body is a two-column grid (one column below
1100px): **Connect** (copyable `ssh` command from the observed public IP, a primary **Open
terminal** button when ready, Get SSH certificate; a stopped VM explains whether starting gives a new
IP (AWS) or keeps it (Azure, `staticPublicIp`)). Open terminal shows a large dialog with an xterm.js screen on the ink background (JetBrains
Mono 13px), the `<cf/ssh-user>@<ip>` status (red "Disconnected: <reason>" when closed, with Reconnect),
and Close; **Activity** (the
active or failed run's compact summary with Retry/Skip, then a History list of runs with kind,
status, requester and time, each linking to its run page), **Configuration** (size, software
chips, AD join, tags; a Modify link) and **Details** (health-check state and age, instance ID,
public IP, requester, first ready, lifecycle, inventory source). Once a refresh finds the
entity gone, the pill reads Destroyed and the body becomes a "Removed from the catalog" notice
with the destroy run link and Back to Resources; it is not claimed until the catalog no
longer returns the entity, and polling stops.
The compact run summary shows its kind/number and status chip, requester/team,
the line, the current or failed stage and its inline error, permitted Retry/Skip
controls, and a View run details link. It deliberately has no stage list, job
steps or attempt history; those belong on the run page, keeping Access and
Desired configuration close to the top of the card.

### VM run page

`/vms/runs/<id>` is a standalone page under the `vm-status` plugin's `/vms`
page extension. It fetches the run without a catalog lookup, so registration may
still be pending. The catalog link is navigation, not a readiness assertion.
The header shows kind/VM, a colored status chip and one muted line containing
requester, team, short start time and elapsed duration. Full start time is a
tooltip; links occupy a consistent separate header group. Retry/Skip sit above
the pipeline card when permitted.
The page extension suppresses the generic plugin banner; the run heading is the
only page title. Terminal stage durations fall back to the run's finish time when
cancellation did not record an individual stage finish.

Each stage is a compact ruled row: colored dot and label, brief description for
work performed/in progress, human status and a right-aligned duration. Mobile
places status below the label and keeps duration at the right. The attempt budget
appears only for retries/history. Pending stages show Waiting; automatic skips
show Not needed, with no placeholder timestamps, zero-attempt counters or empty
job details. Retry countdowns read e.g. Retrying in 1m 20s. Manual skips name the
user and never imply the work was completed.
Any stage's `summary` is shown as a one-line result below its description. The
first provision stage, ServiceNow request, runs inside the IDP; its mock ticket
number appears here rather than in a separate task-page step. In-process stages
have no GitHub run or job steps, so ordinary successful in-process stages have no
empty expander. Retry history/manual attribution can still be inspected when
present; the view does not manufacture GitHub links for them.

A stage that actually ran has one named details expander containing a clearly
labelled GitHub attempt link, job steps with status symbols, earlier attempts,
outcome and manual attribution. Failed/retrying errors remain visible in red
without expanding. Ordinary rows never expose raw timestamp blocks. Run/stage
duration clocks tick only while the run is active.

The standalone view polls `/runs/:id` about every five seconds only while running;
terminal runs stop polling. Successful actions replace the view with the returned
run and resume polling. Retry and Skip exist only when the API's caller-specific
action flags permit them. Skip requires confirmation that work will not be applied
and the desired spec will not change. Both controls disable while a request is
pending; API `{error}` text is shown inline. Read failures show an explicit retry
control on initial load, or an error with continued polling during an active run.
The entity card uses the compact variant without a duplicate per-ID polling loop.

Demo controls and the compute picker's restrictions discover `vms`, using
`/demo/state` and `/demo/settings`; their existing response shapes are unchanged.

### Stock and owned boundaries; known limitations

- **Owned:** theme/BUI browser surfaces, top-bar layout/navigation/mark, home,
  Resources shell and VM columns, product pages, launch flow, kind picker override, VM header/content/card,
  password sign-in composition and VM run pages.
- **Retained plugin building blocks:** catalog filtering/table mechanics, entity
  favourites, InfoCards, search modal/results, template picker/form fields and
  stepper, task controls/logs/output and settings profile/identity cards. Other
  entity pages retain their stock entity content/About card. Plain page themes
  apply to these surfaces but do not make them entirely bespoke.
- **Task handoff:** VM request/modify tasks finish after creating an
  orchestrator run. `VmTaskRedirect.tsx` wraps the new frontend system's stock
  task sub-page, watches the existing long-poll task API and replaces the task
  history entry with the run page after successful completion. It accepts a
  same-origin `/vms/runs/<id>` completion-output link or a positive numeric
  `runId` exposed in completion output. Back returns to the form, not the task.
  Backstage does not expose internal action-step output state through its task
  API; a step's runId must be forwarded into task output to use that fallback.
  Failed/cancelled tasks, missing/invalid run output and non-VM templates (including
  SSH certificates) retain the stock task page, errors, logs, controls and output.
  Removed workflow-progress events have no custom renderer. The task-event
  long-poll workaround remains unchanged; no SSE is reintroduced.
- **Template/form residue:** template card headers are reordered/styled by the
  theme, but their glyphs remain stock. The request-form stepper and its spacing
  gap are still stock; no owned correction is implemented. Their rendered extent
  has not been rechecked for this document.
- **VM context-menu omission:** custom VM headers do not expose stock unregister
  or inspect menus, including for admins. Destroy remains the supported VM-removal
  route. Do not promise these menus as part of the VM-page action inventory.
- **Times retain provenance:** Ready since and Requested refer only to the
  corresponding catalog annotations, not the newest run's creation time. The VM card's
  last-checked time is local catalog-fetch time; catalog checks continue, while
  the header remains based on the enclosing entity. None proves when a workflow
  state changed. The VM product page's refresh dot remains green even when an error is shown;
  it is not independently verified workflow health.
- **Light only:** `theme:app/dark` is disabled in `app-config.yaml`. General
  settings intentionally shows only stock profile and identity cards, not theme
  selection or Pin Sidebar controls. No dark palette is defined here.
- **No invented capabilities:** billing totals, a bulk SSH action and real AD verification
  are not established UI capabilities. The individual VM's Connect panel has a copyable SSH command.
  Demo quota is backend-owned;
  manual retry/skip are exposed only through API action flags. Billing is explicitly
  self-reported; desired software is not a reconciled installed inventory.

Password sign-in is an owned composition of themed MUI controls: a narrow
`maxWidth="xs"` container, top margin, outlined username/password fields, inline
error and full-width primary submit with busy text. It is not a separate visual
world. Session restoration initially shows a spinner.

## Do's and Don'ts

### Do

- **Do** reuse PipelineLine and its state helpers across VM operating surfaces;
  use the run's actual ordered stage list.
- **Do** preserve the distinct non-stop tick, current halo, red cross and squared
  terminus; colour alone is not the whole line grammar.
- **Do** show real next actions and honest timestamps, keeping request age,
  catalog-fetch time and workflow observation age distinct.
- **Do** theme both legacy MUI and BUI, and keep extension changes upgradeable.
- **Do** retain readable metadata and existing responsive behaviour rather than
  inventing a single app-wide breakpoint or spacing scale.

### Don't

- **Don't** add a dark sidebar, gradient page banner or dark-mode promise.
- **Don't** turn skipped into success or destroying into destroyed.
- **Don't** use mono for ordinary VM facts or force tabular numerals globally.
- **Don't** replace the owned VM pipeline with generic badge-plus-bar progress;
  equally, don't claim stock task/form surfaces have already been redesigned.
- **Don't** invent quotas, costs, action eligibility, menu actions or verified freshness.
- **Don't** treat this source-derived document as evidence of a new browser or
  end-to-end verification run.
