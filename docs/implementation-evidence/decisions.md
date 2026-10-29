# Site Factory — журнал решений

Решения ниже сохранены дословно из progress.md в исходном порядке. Более поздние решения заменяют ранние временные границы там, где это прямо указано. Архив содержит также полный shared-context.md, технические ruling-документы, отчёты и ревью.

Снимок: final-complete;16-addressed;2-minor-parked;external-acceptance-pending;branch-kept; исходный HEAD: f89d4604bd31e4052c4ea18a92dd1c53b4badbac. Число строк Ruling: 72.

## Решение 1

- Ruling: Work in linked worktree C:/Users/sazur/.codex/visualizations/2026/10/26/01a1777f-1fed-7cf3-9158-96e8e92fe058/site-factory, branch codex/site-factory-pilot, primary repo C:/Users/sazur/Desktop/site-factory — source files are writable here and Take Control remains untouched. Native create_worktree is bound to the unrelated speech repository and cannot select the new repository, so native Git fallback was used. Cost if wrong: relocate checkout; no product design change.

## Решение 2

- Ruling: Existing approved architecture and user's latest message authorize execution of all 14 tasks with subagents. Do not request approval between tasks. Only credentials/real platform tests and consequential external actions can require human input after independent work is complete.

## Решение 3

- Ruling: Initial repository has documentation only; no baseline test suite or dependencies yet. Do not report absent tests as passing.

## Решение 4

- Ruling: Plan RED wording that expects missing modules is setup evidence, not behavioral TDD evidence. Establish minimal typed skeletons and executable tests, observe actual failing assertions, then implement behavior. No artificial tests for inert configuration. Cost if wrong: a small additional setup step.

## Решение 5

- Ruling: Common signatures are contracts, but definitions whose inputs are assigned to later tasks may be introduced with that producer, not as broken forward imports in Task 1. FileTools is shared type; implementation belongs to worker. Keep contracts independent of apps. Cost if wrong: type-only refactoring.

## Решение 6

- Ruling: ReferenceLibrary.tsx is specified in Task 3 before React exists. Task 3 delivers catalog APIs and data; Task 4 integrates this screen. Admin remote mutation wiring completes with Task 7. No functional scope removed.

## Решение 7

- Ruling: Tests shown with fixture variables in plan require concrete fixtures/builders in each task; literal incomplete snippets are not ready-to-run tests.

## Решение 8

- Ruling: The branch is not complete without the promised native/cloud acceptance evidence. Missing Mac or credentials is recorded explicitly while all runnable code and local tests continue.

## Решение 9

- Task8 NEEDS_CONTEXT handled per handling-reports: approved scoped managed-runtime/remote-worker adapters plus native enrollment/settings beyond brief's short file list. Ruling: transient existing in-memory user session token may pass renderer→dedicated main-local Rust command→configured pinned HTTPS control origin to enroll; server rechecks admin, Rust consumes/stores separate worker credential in OS/private transport and returns safe summary only. No log/persistence of user bearer, redirects/arbitrary per-command origin, or secret return to renderer. Enrollment retry/recovery and launch/stop/revoke lifecycle must be usable. Reason: spec requires actual trusted machines, not fixture-only queue. Cost if wrong: narrowly bounded adapter/native changes.

## Решение 10

- Ruling: Task8 may create normalized private.publication_reservations with UUID, stable request-key binding, origin and settlement link, transferring site_operations atomically. Provider phases stayTask9's ledger. Reserve/settle methods server-only; a worker may request current-lease-bound handoff but cannot assert verified external success. Unresolved reservation survives cancel/revoke/expiry/terminal jobs. Reason: queue lifecycle must not release an unknown external effect. Cost if wrong: migration/seam adjustment before deployment.

## Решение 11

- Task9 automatic continuation ruling: explicit authenticated Resume is fallback, not manual per-site requirement for normal/nightly auto-publication. Approved optional Queue.continuePublications remote tick with empty body; one separately throttled driver per runWorker runs even when both generation slots busy. Server validates unrevoked worker and selects due already-authorized intent; no client target selection/unassigned files/sensitive response. Steps/account locks authoritative across devices, quota/DNS waits free device slots. No automatic offline scheduler/cron claim unless configured; unused cron machinery not needed.

## Решение 12

- Task10 NEEDS_CONTEXT handled per handling-reports. Ruling: approve focused contracts/import, pure bounded parsers, normalized local-database SQLite transaction/ownership/migration/snapshot with existing local factory facades and site-scoped editing, staged import resources, local/postgres batch adapters plus in-transaction site admission extraction, routes/native/client/UI/logo resolver. Set Node minimum >=24.21.0 consistently; bundled runtime already matches. Keep DB transactions synchronous/bounded, no external async work; retain legacy originals through validated reopen. Reason:5000-record scale cannot rely on growing2MB JSON documents; cost is confined local adapter/migration work, central managed authority unchanged.

## Решение 13

- Ruling: Task7 follow-up added002_invitation_attempts.sql, so Task8 queue migration must use003_queue_leases.sql instead of its brief's002_queue_leases.sql. Later tasks use the next unused numeric prefix rather than duplicate migration versions. Reason: immutable ordered Supabase migration identity; filename-only adjustment, no scope/behavior change. Cost if wrong: undeployed filename update.

## Решение 14

- Ruling: Task 5 may publish the accepted immutable Revision itself, keeping draftId/publishedId equal when that accepted version is public. Revision.kind records provenance and is not sufficient proof of publication. Successful publication must have durable site/revision/manifest intent-outcome evidence; Task 9/12 build actual publication history from successful outcomes and initial-generation publication, never from kind alone. Pending/failed intents do not count. Reason: preserve immutable revision identity while keeping accepted/published pointer semantics coherent. Cost if wrong: publication-history adapter refactoring; website bytes unaffected.

## Решение 15

- Ruling: All later Cargo commands must explicitly set CARGO_TARGET_DIR to this checkout/.local-state/cargo-target — host inherited C:/speech-vulkan-ninja caused one initial Task4 build cache write outside checkout. Subsequent build/test commands and committed launcher use local target. Do not delete the external cache or touch speech sources. Cost: duplicate local build cache; avoids unrelated project build-state interference.

## Решение 16

- Ruling: Task 3 introduces immutable RevisionRepository {put,get} and a local adapter, injected as WorkerDeps.revisions. Site.draftId/publishedId always reference Revision.id, not Manifest.id; resolve Revision.manifestId for file access. Persist the intended publication revision identity/metadata with archive and intent before provider calls, register the published revision only after provider reports published, then CAS Site; identical put is idempotent for crash recovery. For edit jobs, archive validated candidate files/private checkpoint without mutating Site pointers/revision or publishing; Task 5 owns registration/accept/reject. Reason: plan omitted revision persistence and direct draft installation would violate approved candidate acceptance. Cost if wrong: additive port adapter refactoring; no change to product flow.

## Решение 17

- Ruling: Task 3 extends CheckpointStore with trusted load(checkpointId), returning checkpoint/private state/files; pipeline verifies job/site ownership and validates restored state. Job.generation may optionally freeze seed/styleId/templateVersion via trusted catalog.prepare; fallback selections persist before assets/model and cannot change on retry, catalog disable, or template update. Missing pinned version fails clearly. Persist archive manifest and deterministic publication intent before any publication call; Task 9 adds real intent storage/wiring. WorkerDeps may inject catalog/workspace/validator in addition to required ports. Reason: saved stages must actually be reloadable and stable without app-to-contract imports. Cost if wrong: type-only orchestration refactoring; no external account side effect.

## Решение 18

Task11 Ruling: approve focused migration007 + optional trusted claim mode visual/all to permit enrolled workers without configured model key to perform deterministic visual Save only. Reason: producer bypass alone cannot overcome managed.start model gate or an unfiltered queue claim; ordinary unenrolled editor selection remains independent. Implement one two-argument claim function with producer predicate BEFORE LIMIT1/FOR UPDATE; retain one-argument behavior through a thin wrapper rather than duplicate state machine. Preserve existing site→worker→job locking, post-lock clock, capacity2, leases120s/30s, reservations/exclusion/fencing and service-only grants/search_path/security-definer. Strict DTO/native allowlists; visual-only never claims AI jobs or creates fake managed generation. Local optional filter uses same semantics. Cover oldest AI job not starved/consumed by visual-only worker and unchanged default claim behavior; explicit native enrollment remains mandatory. Cost: narrow claim/start contract/migration addition, no new executor or weakened ACL.

## Решение 19

Task11 Ruling: approve narrow monotone authorization-denial fence for a pending visual Save when fresh original saver no longer has site:edit and cannot obtain ordinary edit admission. Under existing site lock, refresh original actor rights and terminally fail only that pending Save; no source/pointer mutation or grant of editing admission to user role. Final visual CAS and every journal/candidate update must preserve and recheck terminal denial, including after role restoration and while worker completes. Same-key replay stays terminal; a new explicit Save is separate. Reason: otherwise early GET/status denial leaves durable autoaccept pending and later role restoration can install without fresh Save. Cost: bounded terminal-state authority/fence path, not a second acceptance engine; regression includes downgrade→own status→rights restored→replay/no install and concurrent completion fencing.

## Решение 20

Task11 fix1 Ruling: approve additive trusted final visual-CAS port receipt so managed final authority outcome and existing candidate acceptance/Save journal commit in the SAME site-locked transaction as either denied pre-CAS work or successful draft CAS. Typed completed/failed receipt + trusted journalCommitted indicator lets core avoid a redundant now-revoked guarded write; local adapters retain existing core journal path. Final port must re-read/bind immutable candidate/Save/base/admission and fresh original saver authority, not trust renderer/worker receipt metadata. Early denial classifies actual installed immutable Revision/base receipt before failing outstanding work; terminal fence protects both completed and failed from stale writes. Reuse existing acceptance domain transitions/helpers, no second engine or validation bypass. Own-operation terminal response may expose only existing safe receipt; lost role/site scope must not grant fresh source/projection/archive/site access. If response is forbidden after legitimate install, durable result still completed rather than false failed. Cost: narrow atomic adapter/core return contract, removes two transaction windows; require before-CAS and after-CAS actual-adapter regressions/replay.

## Решение 21

Task12 Ruling: approve adapter-affine portable backupv1: local→fresh local and managed→fresh managed on another configured machine/installation/storage, both complete paths. Source adapter/schema declared and authenticated in format, wrong target adapter rejected before target staging/install. Stable semantic IDs and physical-key remapping/verifiedAuth mapping/quarantine remain required; no dependency on original artifact storage. Cross-adapter local↔managed conversion is a separate validated migration feature, not implicitly promised by independent backup. Reason: local demo principals/SQLite envelopes and managed Auth/provider journals differ; no preexisting user data migration was requested. Cost: v1 cannot directly import demo DB into managed DB; document scope and keep standalone sourceZIP hosting portability separate. Test adapter mismatch leaves target unchanged and real same-adapter independent restore with original store unavailable. No external action/format-dependent install code had run before ruling.

## Решение 22

Task12 locality ruling: approve focused backup-archive.ts (trusted Node streaming crypto/ZIP), local-backup.ts, postgres-backup.ts and common recovery-record validator; required core facades/contracts remain. Reason: filesystem quiesce/root switching and managed Auth/SQL/R2 mapping have distinct responsibilities and should not bloat retention adapters. No new framework/broad rewrite; Node-only implementation stays off renderer imports. Exact paths/report required.

## Решение 23

Task12 Ruling: confirmed managed validation PNG producer gap is load-bearing for approved evidence/backup scope. Approve optional trusted WorkerDeps.readValidationScreenshot(id) and focused lease-bound private screenshot preparation/upload/verification/registration integrated before accepted checkpoint CAS. Use existing bounded staged/signed resource transport, exact site/job/checkpoint/lease/id/hash/MIME binding and current authority recheck; IDs match exact authorized validation/<uuid>.png/legacy rules, not arbitrary paths/URLs. PNG bytes stay out of public site archive, renderer requests and generic private replay DTOs. Registered evidence screenshots must resolve to verified inventory and authorized existing screenshot read endpoint across devices. GC/pins/backup roots cover staging and accepted images. Do not blindly impose logo2048-height bounds on fullpage validation captures; define bounded screenshot envelope matching actual validator and test real375/1440 PNGs. Historical missing images make claimed-complete snapshot unavailable until verified backfill; no placeholder/fabricated historical evidence. Optional hook absent may not silently omit actual production screenshots; fixtures provide valid bytes or explicitly empty fake validation.

## Решение 24

Task12 Ruling: native backup assembly may supply pinned packaged template/reference content absent from control catalog metadata, but only via bounded typed snapshot resource inventory with exact version/content digests and verified installed package source, no arbitrary renderer paths or unchecked version labels. Historical unavailable pinned content is explicit incomplete backup, not silently replaced by newest template. No general asset framework/new provider; focused producer/reader seam closes existing required scope. No native GUI/live provider actions authorized.

## Решение 25

Task12 Ruling: approve concrete checkpoint implementation relocation apps/worker/src/checkpoints.ts→packages/adapters/src/local-checkpoints.ts with compatible app re-export, preserving exact parser/export/import/envelope/path/hash/provenance behavior. Reason: local staged restore must reuse actual existing parser without duplicating it or adapter→app cycle. No state-machine rewrite; existing checkpoint/pipeline/editing and staged restore checks cover move.

## Решение 26

Task12 capacity Ruling: prototype2.147GB/100k/24MB constants confirmed provisional, not required by ZIP64/crypto. Approve format bounds48GiB plaintext per envelope (below2^36−32 GCM bytes),1million ZIP entries,500000 metadata records/256MiB metadata total,32MiB member, authenticated index chunks<=1MiB and lazy multi-pass ZIP. Subject to actual streamed representative5000×6×(5source+2PNG)=210000payload inventory plus metadata/memory checks and separately reported real smaller roundtrips. Do not hold all yauzl Entry objects, one giant index string or all installation logical records in one JS array; disk/SQLite staging/iterators and bounded pages allowed, validation complete before target install. Distinguish projected inventory limit vs measured full-byte throughput, no claim48GiB tested if not. Worst cases beyond one GCM envelope fail explicitly, never truncate; no multipart framework required in v1. Technical bound is not a generation money cap. Existing normal5000 metadata capacity fixture still required.

## Решение 27

Task12 Ruling: approve durable settlement ordinal in NEW008/local sequence to order current+5 exactly when verification milliseconds tie, preserving original observed external timestamps. Preserve/reseed ordinal after restore; legacy ambiguous order cannot be fabricated (provable receipt/revision order or conservative protection/explicit uncertainty). Current pointer always root; tied times and return-to-old-bytes actions tested.

## Решение 28

Task14 lifecycle Ruling: pinned Playwright1.64.1 actually detaches Unix browsers into separate groups (coreBundle10023–36; kill-browser group10104–15), so Node-group-only cleanup is insufficient. Controller read245word preflight correction and approves fixed packaged mac browser-owner helper via supported executablePath, registers own anchored group over private watchdog channel and waitsACK BEFORE starting exact resource Chrome/shell without detaching. Preserve pipes3/4/defaultargs/sandbox; anchor retained through acknowledged cleanup prevents reusedPGID signaling. No public arbitraryPID/executable input or post-launch scraping, no helper GUI/OScredential init/vendor patch. Same seam validation/preview/selection; Windows Job barrier unchanged. Tests for prelaunch/afterspawn timeout/parent failure; actual mac platform evidence remains pending.14stillREADONLY until13 gate/BASE.

## Решение 29

Task12 archive-writer Ruling: pinned yazl3.3.1 source retains all Entry/callbacks and scans from index0 per entry, giving O(N²) at representative755k; tiny ZIP tests cannot justify target. Approve replacing/removing yazl with focused STORE-only ZIP64 writer in trusted backup-archive.ts, using maintained NodeCRC32/SHA/crypto, bounded current member<=32MiB, awaited partial-write-safe I/O and disk-spooled central directory. This is container serialization, not homemade cryptography; AES256GCM/scrypt remain built-in and maintained yauzl strict two-pass reader remains. Verify headers/ZIP64 sizes-offsets/counts/UTF8flags/DOS metadata/CRC against primary PKWARE format, not invented dialect. Cross-check standard-reader interoperability and >65535-entry ZIP64 boundary, corruption/missing/oversize/abort cleanup plus actual index load memory. No compression/append/encryption feature/general ZIP framework added; schema/envelope/path/48GiB resource scope unchanged. No whole-index Map/nameSet/array retained: private SQLite disk inventory/name index approved. New large tests must distinguish projected byte budget from actual authenticated-index and writer exercise, heap/RSS sampled vs peak honestly. Existing prototype usage not final capacity proof.

## Решение 30

Task12 catalog Ruling: approve explicit installed-catalog CURRENT pointer/set plus version→immutable physical bundle edges. GC roots exact current installed set and semantic active/retained-history/evidence version refs and export/snapshot pins; superseded wholly unreferenced bundle becomes eligible after24h, no permanent all-catalog bypass. Current pointer changes only on verified authorized catalog-install/server configuration transition, not ordinary backup read or stale worker/client snapshot upload. Restore preserves recorded source current pointer semantics (not guessed latest timestamp) while storage keys remap; destination package updates must reconcile exact versions. Tests: B1 still rooted by old job/history/pin after currentB2, then B1 collectible after refs/pins gone+grace, B2 survives; stale client cannot roll pointer backward.

## Решение 31

Task12 legacy-local Ruling: where pre008 local envelopes lack durable predecessor proof, do not invent accepted ancestry. Exact reader verifies/registers immutable ID/site/job/physical digest; current pointer, explicit trusted recovery ticket or any existing durable accepted-snapshot marker can prove projection/root. Other envelopes stay acceptance-unknown, kept at least30day detail horizon, then collectible only with complete relevant incoming-root/reference coverage, no execution/retained/evidence/read/export pin and24h observed grace. Unknown version/closure blocks that subject rather than unsafe inference. Preserve inventory identity/hash/provenance after payload pruning. Do not classify unknown as accepted/unaccepted or permit new references to tombstoned payload. Existing reviewed older accepted-snapshot recovery must use its actual durable authority marker if present; unsupported legacy eligibility is explicit, not file-presence authorization. Latest pointer alone updates latest usage, older proven CP evidence/edges only. This allows unnecessary legacy detail expiry without blanket permanent protection and preserves required current/history/recovery roots.

## Решение 32

Task12 recovery reconciliation Ruling: require the narrow product admin route/UI, not offline SQL-only escape, because unresolved restored effects are an expected recovery case. Add read-only existing-publisher inspection/receipt adapter bound to restoreId+reservationId+configured account scope+immutable frozen binding+original evidence digest; preserve source provenance. No Vercel PUT/POST/DELETE/upload/promote/automatic recomputation or new publication framework. Exact server-observed terminal proof may use existing normal settlement/cancellation transitions; ambiguous/no-proof case returns concrete manual-reconciliation-required with quarantine/exclusion retained. Operator source-retirement/account acknowledgment is necessary but not a substitute for provider proof, and a client confirmed:true/raw text must never release unknown effects. Fresh admin/binding recheck on commit, network outside DB locks under proper pins, stale concurrent inspection rejected/idempotent. UI exposes safe status/action, not secrets/raw provider data. Tests assert no provider mutation across all branches and no release on ambiguous/forged/stale proof. Actual provider/account/platform acceptance remains14; implement adapter/route/tests now. Recovery docs still cover genuine out-of-band cases without unsafe blanket clearing.

## Решение 33

Task12 fix1 I5 Ruling: approve internal retention-sql.ts focused dialect-specific scalar roots(kind,id,purpose)/recursiveUNION closure in DB-managed temp tables/indexes; adapters own FIRST fences/transactions/I/O, core semantics preserved. Setwise GC+durable claims then64row outside-transaction reads; localprotected paged iterable preserves purposes/legacy/proven recovery roots. SQL count/serialized-byte budgets before hydration/backfill/capture with coherent recheck, statement/workmem bounds and explicit rollback failure, includes edges/evidence/inventory; no NodeFS/network/crypto under locks. Actual5000×6 metadata/edge snapshot/GC required, no13.7GB bodies. Bounded scalar catalog header list allowed (prefer existing count/byte limits; proposed10000 only explicit upfront technical bound, never slice/latest substitution), cleanup bounded batches must leave remaining work discoverable. Why: resolves explicit no-whole-installation-array ruling with existing normalized stores; cost if wrong: focused SQL seam/performance rework, no product scope change.

## Решение 34

Task12 fix1 I5 measured actual target:5000×6 with5source+2PNG has630008logical DB rows incl240k typededges/120kinventories,270000physical-file descriptors (150ksource/60kPNG/60kdetail),900009metadata records and1170009old-layoutZIPmembers beforeindexes. SQLaggregate actual serialized logical450854933B+descriptor81300000B=532154933B; bodies13.5GBprojected NOT written;seed+aggregate30.24s. Savedtask12-fix1-full-volume.json. Root Ruling: old500k/256MiB/onerecord-member assumptions undercounted promised normal target, do not reduce fixture to light success. Approve focused optional typed embedded file-descriptor fields on paired authenticated index entries (recordName/root/path/MIME, reuse authenticated payloadname/size/hash), disk reconstruction with all prior root/path/MIME/binding/duplicate/unmatched checks, old archives readable/new unsupported features failclosed; no bodygrouping/framework/crypto/sourceZIPchange. Count expanded logicalrows+descriptors. New metadata1Mrecords/768MiBserialized, retain1MZIPentries/48GiBplaintext/32MiBmember/<=1MiBindexchunks/192MiBindexpendingactualmeasurement.512MiB only4.7MB beyondmeasuredtarget insufficient for approvedTask13aggregate rows,768MiBboundedheadroom while nohydration. Approve exactsafeBIGINT namespaces originals<1M,chunks[1B,3B),verified4B,metadata5B,prepared6B with boundedstrides/routing and rejectoverlap/outofrange. Reason: support measured requiredtarget rather than certify undercounted capacity; costifwrong: focusedformatcompat/performance rework, no externalservice/purchases. Required old/newpairedroundtrips, hostilecompactdescriptors, actualfulltargetsnapshot/GCcount/bytes success, trueoverboundupfrontreject/zeroremnants, no13.5GBbodyclaim. If192MiBindex insufficient require exactmeasure beforefurtherchange.

## Решение 35

Task12 fix1 I5 measured capture/locking Ruling: full900009record attempt after scopedcachecleanup(Cfree4.93GB) reachedmetadataINSERTs then15sclosuretimeout. Owner identified UUIDevidence e.id::text anti-index scan underOR, fixingtemptextPKevidenceIDs, closure-before-copy and duplicatepreflight. Fullcopy itself tensofseconds exclusive fence, so approve DEDICATED managedsnapshot SESSION-SHARED advisoryfence on checkedout physicalsession BEFORE BEGIN REPEATABLE READ; coherentMVCCmaterialization/pins commit thenunlock/release, rollback/unlock everyfailure/destroyconn ifunlockuncertain, no upgrades. Ordinarytransactionfirstshared andGC/restorefirstexclusiveunchanged. BEGINRRthenblockingadvisorySELECT isunsafe(MVCCsnapshot mayprecede waitingcollectorcommit). Explicit server direct/session capability required BEFORE anysessionlock; unknown/transactionmodebackupfailsclear, no URL/portguess/sessionlockprobe/secondDBURL/newservice. CurrentDATABASE_URL hadnomodecontract. Verified official Supabase https://supabase.com/docs/guides/database/connecting-to-postgres transactionmodelimitations and PostgreSQL https://www.postgresql.org/docs/18/sql-set-transaction.html / https://www.postgresql.org/docs/current/mvcc-serialization-failure-handling.html; sessionstate/locks unsupportedacrosstransactionpoolerqueries, RRfirstquerysnapshotfixed. Sameauthority/sessiondocumentedconfiguration; costifwrong: requireoperatorcorrectdirect/sessionendpoint/rollbackfeature, notcorruptsnapshot or globalwriterpause. Testcollector-before/queuedcapture, ordinarywriterduringcapture, observedGCwaituntilcommittedpinsandrespectafter, failuretimeout0snapshots/pins/nolocks, denyunknown/transactionbeforelock, destroyunlockfailure. FreshfinalauthorityviaSAMEsessionRCaftercommit OR afterunlock/releaseordinaryfreshcheck; doNOT open2ndsharedwhileholdingSESSIONsharedbehindqueuedGC(deadlock). RRrereadnotfresh. NoNodeIOunderlocks, statement/timeworkmembounds, measuredshared-durationreportedhonestly. Thisfocusedcaptureexception supersedesoldexclusivesnapshotrulingonly, no generalisolationframework.

## Решение 36

Task12 fix1 I5 transport Ruling: measured58sbeginSnapshot exceeds NativeArchives.call30s blanketdeadline. Approve180s ONLYexactPOST/admin/recovery/snapshots issuance, fixedtrustedselector/backgroundprivate operation; ordinary/chunk30s, snapshot1h/nativeop30minunchanged. Bounded declared-safeAppErrorcode/message propagation for actionableDBmodeerror; knowncodes/response+textbounds, rawprovider/DB/stacks/unknownerrorsgeneric. Checkedcontrolvercel.json onlyrewrite; official https://vercel.com/docs/fluid-compute confirms HobbyFluid300smax and https://vercel.com/docs/project-configuration/vercel-json supportsperfunctionmaxDuration. Approve LOCALfluid:true +functions api/index.ts maxDuration240 preserve rewrite (180clientheadroombelow300max); boundedcaptureSQLtotal/query belowclientdeadline, documentactualFluid/direct-sessionconfig, no providerdeploy/tierpurchase/action/priceclaim. Why: actualsupportedmetadatacaptureotherwiseunreachablefromnativepath; costifwrong: focusedtimeout/deploymentconfigrollback, platformacceptanceremains14. No mirror-onlyconstanttest; focusedactualtimeout/errorboundarywherepractical.

## Решение 37

Ruling: addTask15transportreachability prerequisite afterTask12reviewgate before13→14, preserveexistingtasknumbers. Read-onlyTask14auditactualcodeperrecord900009GET/1800018POST+singleinstall45001SELECTminimum exposes reachable-sizegap despite boundedrepresentation; conditionalRTTarithmeticNOTbenchmark. Focusednewtaskbyte/countboundedremote batches, durablepagedprepare/atomiccommit, boundedrenewal/cancel/freshauthority; preservearchive/native64k boundaries/providers/productscope. Userapprovedcompleteimplementation/subagents/no repeatedconfirmation, thisclosesexistinglargebackuprequirement, no newproductapprovalgate. Cost: additionalserialtask+independentreview, no service/purchase. Trackedplan updatedbycontrollerONLYdocumentation, pendingcommitownednexttask; no productioncodeedited. Task12scopedfixreviewcontinues2d2aHEADpackageunchanged; Task15productionnotGOyet.

## Решение 38

Task15 preflight974words READY readfull bycontroller; handling-reports reference reread. Ruling: approve boundedbatch+operational009progress/receipts/claims and separatelypagedpreparation/atomiccommit against2d2a9e4. Portablelogicalschema8/formatunchanged because009operational-onlyexcluded, SQLschema/migrationnumbernotinventedbackupschemabump. Raw1MiB/JSON2MiB/metadata256/resource64/runnerinflight4; permetadatarecord1000000B is EXISTINGrecovery-records.ts70/112/postgres-backup.ts124limit verifiedbynarrowrg, notnewdowngrade. Route-specificlargerparserONLYexactadmintransferpathsafterAuth/scope, other64k/native24kunchanged. Hash/receiptbindingexcludesmutableTTL/credentials, descriptorwindow/cursor/count/bytes completenessserververified, conditionalwriteexactreplayonly. Preserve64MiBglobalobject-stagingbudget andschedulelarge32MiBobjectswithoutquota-deadlock; no budgetbypass.

## Решение 39

Task15 lifetime/session Ruling: successfulauthorizedtransfer/progress renewslivepins60min capped24h, no revival, no databasekeepaliveafterwork/polling/disposalends; sourcepinsreleaseassoonnolongerneeded. Credentialsvolatileonly; stableJWTsessionidentityacceptedONLYfromexactbearerverifiedbyconfiguredcontrol/session andserverAuthPort, notbody/unverifiedclaim/userIdalone; opaque/missing-stable-sessionexact-tokenfallbackwithclearreauth-requiredstateandboundedstagingexpiry. Sameverifiedsessionrefreshupdatesonlyinmemoryslot, true logout/newsession/origin/mode/roleloss cancel+drain, cleanupsdoNOTgrantread/renew. Working-statuscache≤30s SAMEexacttoken onlysafeprogress metadata, notfinalhandles/files/reads/save/issuance/caprenew; tokenchange/newaction/releasefreshverify, eachbatchfreshserveradmin. ExistingcorePrincipalcontractsnotreplacedbynewAuthframework; privateverifiedcontextkeepsauthoritynotserializedclaims. ReportactualHTTPsession/renewoverheadinsidebudgets.

## Решение 40

Task15 prepare/commit Ruling: ≤256records/1MiBcohort, cooperative10srequestwork withboundedexistingone-recordIO, durablevalidationphases/claims, batcheduuid/keylookups+preparedinserts; immutableverifiedbodydigestsreuseinsteadrevalidatingeverypayloadperstep. FinalreadycommitonlyknownSQLtablesunderexistingFIRSTexclusive/freshauthority/emptytarget/quarantine/provenancereport, perstmt15s/cumulative105s/lockwait5s/client180exactcommitendpointifneededbelowFluid240; no network/FS/crypto incommit. Existingactor/sourceidentity/privateprojection/quarantine/publisheraccountsemanticsunchanged. Internalrestore-ownerexclusionfromclosewaitmustbeunforgeableinternalcapability, notrendererprovidedskip; allotherownedrequests+maintenancejoinedbeforeDBclose. No newproviders/dependencies/crypto/archivecontainer/generalworkflow. Alltest/callbudget/disk/actualvsconditionalevidence requirements retained. Reason: closeexistingapprovedbackupreachability/closegap, notnewproductfeature;costfocusedprotocol/adaptorworkandreview.

## Решение 41

Task15 renewal-scale guard Ruling: coalesce durableTTL/pinupdates; successfulfreshlyauthorizedbatchmayreturncurrentliveexpiry, avoid120k/270kpinrewrites×~3500pages. Renewnear-expiryboundedsetwise/or equivalentownerjoin, no expired/claimedrevival, nativeopcoveredbyreturnedliveexpiry. Freshadmin/scopeEVERYbatchunchanged, no privilegecache/newbackgroundscheduler. Fulltargetactualcost catches regression; no mirror-onlytestdemand.

## Решение 42

Task15 securityselfreview Ruling: operationalverifiedsessionboundATsnapshot/restoreissuance, neverfirst-readeradoption. Every snapshot/restoreTRANSFER-IDHTTProute (legacyrecord/resource/stage/mappings/install/IDstatus/release +newbatch/prepare/commit/renew/cancel) guardbeforeprivateaccess/mutation; no userIdonly/bodySID/scopefreeHTTPfallback. Oldunboundpreupgradecapsfailclosed/recreate. Directtrustedadaptercompatprivateonly. Addsameuser/newSIDoldroute+beforefirstbatchnegative/sameverifiedSIDrefreshpositive. ApplyAFTERcurrentfrozenfullrunfirstresult, thencoveringguards/evidencesequencing. CLARIFICATION: installation-wide GET/admin/recovery/status andPOST/admin/recovery/release NOtransferID remainexistingfreshadmin/quarantine/accountauthority; publicationreconciliationIDsexistingindependentrestore/evidence/frozenbindingauthority. Newauthorizedadmin/deviceCANfinishdurablerecoveryafteroldtransfersessionTTL; no newglobalSIDrestriction. Thisclosesnewtemporarycapabilitybypass, preservesproductworkflow/corePrincipal/archive/portabletables.

## Решение 43

Task15 prepare-bound Ruling: approvepurecheckpoint-evidence-from-file-digestshelper extractedfromexistingprojectCheckpoint(bytes), bytewrapperdelegates/outputsunchanged, no duplicateprojection/state machine. RestoreinputsONLYservertrustedimmutableperobjectproofsexactpath/size/MIME/SHA256/SHA1matchedmanifest; missingoldSHA1computedinexistingboundedbodyverification/proofupgrade, NEVERtrustclient/manifestSHA1orinfersolelySHA256. Preserveimage/producer/site/authority/source-targethash/Authprovenance. StateoneboundedR2read;no newformat/HTTPprojectioninput/dependency. Behaviorno-fileredownload+bytepathequivalence/existingevidence/native/mappedvisualcoveringrequired. ApplyAFTERcurrentfrozenfullrunfirstresult, recordchangedpathsequencing.

## Решение 44

Task15 /session Ruling: freshmembership-ONLYplaincurrentSELECT AFTERexactbearerauthenticationmayavoidinstallationpayloadfence; inspectentireauthenticationpathsoearlierresolverdoesn'tstilllock. NormalFIRSTsharedtx andallrealtransfer/resource/prepare/commitfreshAdmin/payloadfencesunchanged,no rolecache/globalAuthframework/Principalchange. Safeexistingprincipalprojectiononly,nopayloadrefs. HeldEXCLUSIVEcommitregression/sessioncurrentroleresponsive/realbytesstillfenced/rolelossnohandles;name/handlepoolstarvationifobserved. Why: actual40.35scommitfits105SQL/180client/240Fluid butworkingstatus30srevalidationmustnotcancelvalidcommit; no privilegeextension. Read-onlymembershipdoesnotcreatepayloadrefs andneedsnolivenessfence. No newDBauthority/service/timeouts.

## Решение 45

Task15 exactpreparepageEXPLAIN cursor235007 healthy1.776ms/256rows/indexedPK2072hits51reads0filtered; evidence.local-state/task15-final-prepare-plan.json. Rootruling: afterfrozenfirstverdict implementexistingbriefboundedcohort bulk immutable availability/source/producer reads≤256/1MiB, shortexistingFIRSTsharedfenceSQL, preserveEVERYtyped/perobjectvalidator/freshrequestactorSID/finalreadycommitchecks; no globalcache/clienttruth/networkFScryptounderTX. Reasonperrecordshorttransactionoverheadmeasured, nopagination/plannertweak/no raisedguard. Owner mustsurfaceauthoritysemanticdifferencesbeforecode; sourcefrozenuntilcurrentverdict.

## Решение 46

Task14 NEEDS_CONTEXT preflight574word delta read FULL; handling-reports reread. Ruling: approve exact finalized manifest SHA256/target/format compiled into main native executable, helpers finalized first/main outside resource inventory/privateIPC anchor/no mutable release env or renderer override/adjacent self-anchor. Nested signed bytes finalized before manifest; final outer signing cannot rewrite them. Unsigned executable replacement outside integrity claim/no new PKI. Why: current existence-only resolver and adjacent checksum cannot establish trusted expected contents; cost extra deterministic build ordering and per-file prelaunch validation. Serial measured disk plan approved2GiBfloor/statedphasecaps/no cache or current-binary deletion; exact capacity mismatch goesROOT for technical ruling, not human stall. Stillread-only/idle until13cleanBASE+explicit14GO.

## Решение 47

Task13 NEEDS_CONTEXT storageUUID question resolved after rereading handling-reports. Ruling: separate read-only stored observation/provenance/frozen-expectation validator accepts canonical8-4-4-4-12hex ALL128bit PostgreSQL UUID values, including md5 fixture arbitraryversion/variant; exactsame-site/currentpublicationbinding retained. No widening renderer/worker actiontarget/claim/token/auth parsers or rewriting stablefixtureIDs. Why: stored UUID compatibility differs from generation/version-specific API syntax; cost if reused wrongly is unintended parser widening, so focused malformed/nonmatching+arbitrarybits tests required. CurrentfocusedSQL61PASS/2sameUUIDfail outof63; no fullcapacitystarted. Normalunit392PASS/2SKIP/13FAIL:oneoldgenericclaimfixtureamended,12timeouts/aftereachEBUSYunder overlappingSQL. Bothended; named4files thenfullunitsALONE/originaltimeouts, preservefailures/no blanketloadexcuse. AllSQL/native/E2E/fullgates serialized;free10,177,126,400BbeforeRust/full.

## Решение 48

Task13 isolatednormalunitstill5s pipeline/edit timeouts+desktopRetryassertion(finaloutputpending), so initialload-onlyhypothesisnotaccepted. Namedlikelyintroducedcost: ActivityTimersealsrecordActivitybeforeEVERYcheck/heartbeat/toolcontinuation→manysynchronousFULLSQLitecommits. Ruling: measurehookwrites/overheadinmeaningfulfixture then coalescebounded30swindows+actualleaseending/jobpause; in-memoryactiveintervalsubtotals/exclusions neednotdurablewriteeverypause, preservefreshauthority/contiguousidempotence/one rowjob/eligiblefinalseal/nullpartial/unsealedgapdiscard. No guardraise/replayrewrite. Server-relativehealthsleep andallowlistedpublicationdiagnosticprojection alreadyapprovedscopealsofinishingBEFOREfullfreeze. Recordandfixrepeatfailuresratherthanexcuseasload.

## Решение 49

Task13 measured activity overheadRED shortjob13durablerecordActivitycommits target≤7; initialboundary-onlyGREEN thenstrongercoalescing correction chosen. Ruling: optionaltrustedActivitySegment on existingQueue.finish/pauseAtBoundary+workerDTO, apply in SAMEactualleaseendingtransaction/freshauthority using shared existing replay-validation helper. Falsepauseboundary doesNOTconsume/reset candidate/sequence. Drain/resolvependingperiodicseal orreplayEXACTimmutablependingsegmentanddiscardunsealedtail; nevermutateambiguoussubmittedsegment. Onerowjob/contiguousmarkers/partialcoverage/unchangedqueuecheckpointsemantics preserved; no renderer authority/newaccountingengine. Actualadapterfalseboundary→finish/pause/race/pendingidenticalreplay tests andnoextraordinarydurablecommitRPC forshortmany-check job required. Why: remove introduced percheck FULLSQLitewrite regression while preservingatomic finaltime at realpause/end; cost small additive trusted port/DTO seam.30speriodicwindowsremain/originaltimeoutsunchanged.

## Решение 50

Task13 atomicactivity actualSQLiteGREEN3falsechecks+finish=4existingtransactions/0extraactivitycalls/30ms; actualpause race+lostACKperiodicreplay95msonce/onerow. FocusedSQL55PASS/1heavyfiltered includesstoreUUID/schema9/diagnostic/PGfalsechecks→atomicfinish. ThirdnormalunitALONEstilldifferent5stimeouts evenfakeQueuewithoutactivityport; no blanketactivitycause/defaultpassclaim. Ruling: ONEentirenormalunitset --maxWorkers=1 samecases/5s120sguards, explicitmulticonnectionracesinsidefilesretained. Preservedefaultfailures/reportserialnotdefaultpass; no moreunchangeddefaultfullretries. Task14ownsresource-budgettestlauncherfinalverify. Do NOTwideninitializeRecoverylegacyDDLoptimizationonunmeasuredsuspicion. Cost: slowerboundedfileparallelismwhilekeepingsemantictests/guards; ifserialalsofails, actualcode/fixtureinvestigationrequired.

## Решение 51

Task14 Ruling: approved Mac private proxy/direct anchor ownership mechanism is saved in task-14-mac-ownership-ruling.md. Watchdog retains direct Child until group cleanup, proxy death cleans actual browser, watchdog EOF triggers anchor self-group cleanup; exact private fds/args, no selectors/sandbox disabling/credentials. Actual Mac acceptance pending. A quoted scratch-note append failed before this corrected reference; no product code changed.

## Решение 52

Ruling: Task14 Mac-only supported macOS.files maps the fixed staged runtime to Contents/Resources/runtime, while generic resources is empty on Mac only and unchanged on Windows — pinned Tauri2.12.2 generic copy_file dereferences symlinks while copy_dir for macOS.files preserves framework directory links — cost if wrong is Mac package layout/signature failure; exact target config and post-app inventory must verify modes/links/hashes, actual Mac execution remains pending. No vendor patch/new Mac staging tree on this Windows host.

## Решение 53

Ruling: after installer inspection/native/corruption/recovery evidence and hashes/JSON are saved, retire only the single owned temporary extracted inspection tree after absolute containment/identity and child-exit checks — an additional retained ~1.1GB tree unnecessarily competes with the final940k gate — cost if wrong is having to re-extract the kept installer. Keep final installer/current release/runtime/stage/caches and unrelated files. Before unfiltered verify reserve at least3GiB estimated temporary spool+PG/index/WAL working space above2GiB free floor; owner must report exact new Task14 intermediate categories and safe reclaim/rebuild consequences before any further cleanup or launch, not silently exceed the floor.

## Решение 54

Ruling: validate extracted NSIS main against the full expected bytes derived from the checked portable main using pinned Tauri2.12.2's exact first __TAURI_BUNDLE_TYPE_VAR_UNK to NSS replacement — bundler bundle.rs35–89/124–135/195–201 deliberately patches and restores this marker, so literal portable/installed hash equality is incorrect — cost if wrong is rejecting or accepting a wrong main, prevented by exact marker/bounds/replacement-count and complete derived expected SHA comparison. No arbitrary difference allowlist, resource inventory relaxation or recompression. Record distinct portable2553ac6b...1972240 and installed97d78d17...a74b34 SHA256s. Only3 marker bytes differ at7264194, both9618944B. Installer474989857B plus inspection1102785526B is1577775383B, below1.5GiB; free2752303104B above2GiB. Actual extracted diagnostics still pending.

## Решение 55

Ruling: after bounded pilot exits and installer/native/corruption/recovery proof is saved, retire only six inventoried Task14-generated native intermediate directories (1519295531B; all born after first release2026-10-29T05:57:43Z) plus the owned Windows staged runtime (~878MB) after saving exact inventory/hash/mode proof and verifying equivalence to KEPT release/runtime — extraction+intermediates alone leave only17463329B beyond3GiB estimated working+2GiB floor, too narrow for full940k — cost if wrong is deterministic restage and ~7m36s Cargo dependency rebuild, not loss of a current app. Preserve all pre-task debug/native/registry/download caches, verified compressed archives, top release executable/runtime, final installer and source/evidence. Native candidates: host release/deps525328483B, release/build199440964B, fingerprint170961B; x64release/deps761930950B, build32269972B, fingerprint154201B. Check exact resolved workspace paths/creation identity/no running children and native LiteralPath only, record before/after bytes/free, no broad cleanup. Remeasure expected≥6.26GB before unfiltered gate; if stage is not solely owned/equivalent, report alternatives rather than delete or weaken fixtures/guards.

## Решение 56

Ruling: measuredprepare37888/940022at500.63s/free2384809984B leaves only237326336B above hard2GiBfloor, so retire ONLY8 newlyTask14-created compressed Mac archives under .local-state/runtime-cache/darwin-arm64 anddarwin-x64 —723167042B total, each birth2026-10-29T06:28:39–06:29:07Z/full lockSHA reverified, Macheader/mode/noticesproof preserved — tokeepunchangedfrozen940kverificationawayfromdisk-full. Exactarm64filesnode-v24.21.0-darwin-arm64.tar.gz52909993B,chromium-1248.zip194831853B,chromium-headless-shell-1248.zip103778487B,ffmpeg-1013.zip1430308B; x64node-v24.21.0-darwin-x64.tar.gz54203979B,chromium-1248.zip205332100B,chromium-headless-shell-1248.zip109130614B,ffmpeg-1013.zip1549708B. Recheckabsolutecontainedidentity/birth/hash, nativeLiteralPathfiledeleteonly/savebeforeafterJSON. Preservecommittedlock/evidence/ALLWindowsarchives/pre-taskcaches/currentrelease/runtime/finalinstaller. Costifwrong: exactverifiedfutureMacredownload~723MB, no lostuser/source/provenance. Thisnarrowmeasurednew-artifactexception supersedes earlierkeep-all-caches rule only for these8files; no broadcleanup/sourcefixtureguardchange/competinggate. SAME42308continues, actualafterfreepending.

## Решение 57

Ruling: prepare808448/940022at935.99s/free2577784832B leaves430301184Bfloor-margin, withunmeasuredfinaltargettables/indexes/WALpeak, so approve retirement ONLYnewTask14Windowscompressedarchive set370310712B selected by committedwin32-x64source lock under.local-state/runtime-cache/win32-x64 — saveexactpaths/sizes/births/lockSHA andresolvednon-reparsecontainednew-fileidentity beforeLiteralPathremoval, before/afterJSON/free afterward — costfutureverified~370MBredownload/restage; currentrelease/runtime/main/finalinstaller/inspectorbinary+sourcearchives+recipe+allpre-taskcachesstay. NarrowexceptiontoearlierkeepWindowsarchivesONLYtheselockednewfiles, no broader70MBtoolcleanup/sourcefixtureguardchange/competinggate. Subsequentcrossedownerboundary1021.08sALL940022prepared/7381preparecalls/ONEatomiccommitinflight/free2380091392B(232607744Bfloor-margin). Exactretirementauthoritysentalready, actualfree/verdictpending; do notclaimPASSfromcommitdispatch.

## Решение 58

Ruling: fixMacownershipsocketonlyunderashortsecurelycreatedowner-onlyprivateIPCdirectory independentofapp-data/TMPDIRlength (fixedshortMacOSroot suchas/private/tmp plusfreshprivate0700directory, exclusivecreation/authenticatedexistinghelperchannel/ownedcleanup); persistedDB/browserprofilesstayapp-data — ordinarylongMacrootcurrentlydeterministicallybreaksstartup/package-smoke — costifwrong: focusedtemporaryIPCallocation/cleanuprework, no newbroker/arbitraryselectors/weakerauth/callerpaths/lengthboundrelaxation. Preserveexistingtoken/direct-parent/FD1–4+5/groupanchorprotocol andsalt/noncechecks; coverlongdata+normalMacsmoke shape/normalfailurecleanup andbothMacchecks. ActualMacexecutionstayspending. Windowsartifact/runtimeimpactmustbeclassifiedfromactualtouchedsources beforeanyrebuild; no blanketheavySQLrerun.

## Решение 59

Ruling: reuse the explicitly named linked worktree despite this chat starting in pipe; use narrowly scoped sandbox escalations for writes to that checkout and Git common metadata — preserves the reviewed branch and existing evidence without copying the project — cost if wrong: access review or path correction; no product behavior changes.

## Решение 60

Ruling: preserve every plan-local Markdown document in a tracked SHA256-verified archive plus inventory and exhaustive readable Ruling record before untracking the accidental Task1 scratch report — durable review evidence must survive later SDD cleanup — cost if wrong: regenerate the documentation archive from preserved originals; no production source or artifact changes.

## Решение 61

Ruling: final fix wave addresses all reported runnable Important and Minor findings in one sole-owner implementation, followed by exactly one scoped a345580..fixHEAD rereview — this follows the agreed final-review procedure and avoids per-finding owners/repeated wide suites — cost if wrong: residual defects must be explicitly adjudicated after that single rereview, not hidden in an unlimited wave.

## Решение 62

Ruling: keep the one-operation/publication reservation boundary while exposing a checked unpublished draft; edit is permitted only after safe cancellation or settlement, never during an unresolved provider outcome — the draft-access requirement and concurrency requirement both bind the solution — cost if wrong: a limited draft/publication state transition rework; no weakened exclusion or provider effect replay.

## Решение 63

Ruling: live-preflight remains a disclosed configuration preflight and is not a separate missing CLI orchestrator; actual multi-device/provider/site/visual acceptance remains external and pending — the approved plan specifies the exercise, not automatic execution of every physical/user action by the CLI — cost if wrong: add an authorized automation wrapper later, without relabeling unrun acceptance.

## Решение 64

Ruling: replace the quota-stopped sole production owner with available gpt-6.1-sol while continuing the SAME final wave/FIX_BASE and retaining all partial changes — retrying the exhausted Terra model buys no progress and neither a second wave nor parallel owners is needed — cost if wrong: context reconstruction and targeted re-verification; original broad review and required single scoped rereview remain unchanged.

## Решение 65

Ruling: I2 installs the FIRST checked draft and its immutable Revision within the existing fresh lease/checkpoint transaction, without a revision increment only when there was no prior draft/published content — exclusive generation ownership and unchanged frozen publication CAS make this a narrow initialization, not a general same-revision pointer replacement — cost if wrong: localized first-draft initialization seam/migration rework; ordinary CAS and publication reservations remain binding. Require current job/generation/site baseRevision and atomic checkpoint+revision+draft pointer, exact replay only, refusal of a different existing draft. Preserve immutable revision metadata/kind at settlement and derive actual publication from durable outcome. Active/unknown reservation keeps draft read-only; conclusively safe pre-dispatch cancellation retains draft and fences stale settlement. Cover initialization/replay, different prior draft refusal, safe cancel/edit, resume and unknown outcome. Sole owner /root/final_fix_resume received ruling; broader retry replacement would need a specific followup.

## Решение 66

Ruling: current local unsigned Windows release/NSIS build, fixed CLI/headless pre-bundle smoke and read-only installer extraction checks are already authorized by Task14 and continued execution; installer execution/native GUI/credential stores/live services/publisher signing remain separate — changed JS/UI/native/package inputs require a valid current artifact rather than relabeling historical bytes — cost if wrong: local build time and regenerable outputs, no external account/distribution effect. Sole owner must preserve the verified previous usable main/runtime/installer pair in an exact owned contained pre-final backup before replacement, report bytes/hashes, then freeze final source and regenerate trusted stage/provenance/compiled manifest/main, smoke before NSIS, inspect extracted output. Current free~105GB permits at most2GiB additional historical-artifact preservation separately from normal bounded prep/build phases; retain2GiB free floor and all existing artifacts/caches, no cleanup. Pinned verified Windows redownload or verified-byte reuse if needed is within existing packaging scope, with source/bytes evidence. No source mutation during active gate.

## Решение 67

Ruling: I10 requires truly idle/no-active-work polling to stop after the initial refresh and resume on focus/visibility/manual action; permanent60s idle polling still conflicts with the binding plan's no-continuous-polling requirement — the review's suggestion to suspend OR back off is subordinate to that stated product constraint — cost if wrong: a small scheduler/UI delta and warm current-artifact regeneration; no paid provider or external effect. Queued/running work may retain bounded backoff, hidden windows0requests, actions fresh authorization. Same sole owner /root/final_fix_resume resumed BEFORE any scoped review to complete this SAME wave; no second wave or duplicate reviewer. Only fake-clock/resume/active-cadence and relevant UI/typecheck/build plus regenerated current prebundle/NSIS/extracted checks required; no unrelated broad unit/SQL/capacity repeat or duplicate historical backup. If source already makes idle finite, owner may provide evidence instead of changing it.

## Решение 68

Ruling: add optional read-only ImportSummary.activeWork computed in the existing bounded per-batch SQLite/Postgres aggregate, without schema change or new authority — batch state remains active after jobs finish and visible rows alone miss off-page work, so the UI needs a safe batch-wide activity projection — cost if wrong: localized projection/scheduler rework and targeted regressions. Count queued/running or genuinely scheduled/admittable work, not valid rows deliberately left unselected for a later explicit commit. Paused/terminal/preview or fully settled batches stop, pending off-page jobs retain bounded updates; role/namespace and response-size limits remain. Cover final scheduled jobs completed with leftover unselected-valid/invalid rows. Controller approved same-wave localized seam; no unrelated broad SQL repeat.

## Решение 69

Ruling: park NB1 as real deferred Minor after the agreed single final rereview — uppercase local domain filter plus second DTO byte-budget truncation emits cursor with raw rather than normalized filter binding, reproduced41to39rows/INVALID_INPUT; it is localized and not load-bearing for the closed workflows — cost if wrong: local next-page search failure; lowercase or remove filter and restart pagination until maintenance normalizes this cursor path. No data loss or managed cursor failure is claimed. Keep exact probe/citations in permanent final-rereview report.

## Решение 70

Ruling: park NB2 as real deferred Minor after the agreed single final rereview — registry/batch activity stops on waiting_provider while independent publication reconciliation can still settle; backend publication/reservations remain intact and the issue is display freshness — cost if wrong: stale displayed status until manual refresh/focus or opening PublicationPanel, whose bounded pending-settlement updates work. Future maintenance should expose safe pending-publication activity instead of restoring idle polling. This residual does not authorize a second unreviewed wave.

## Решение 71

Ruling: keep the ignored SDD scratch as well as the verified permanent archive because the final report retains2adjudicatedMinor and is not an unqualified clean result; do not trigger the skill's clean-review-only scratch deletion — preserves convenient exact followup context without losing reports — cost if wrong: a few MB of ignored duplicate records. Worktree, branch, all current/historical usable artifacts and .local-state raw proofs remain. Original Task1 report was already untracked only after verified preservation; no dirty deletion. User explicitly chose keeping branch/worktree; no merge/push/menu confirmation is needed.

## Решение 72

Ruling: deliver every recorded Ruling in a permanent readable decisions.md and link it prominently in final handoff, alongside full archive/inventory/final reports — the user's requested durable evidence/decisions survive scratch and chat context, with all later corrections preserved in order — cost if wrong: readers must open the linked exhaustive record for detail; no decision is silently dropped or lost with temporary files.
