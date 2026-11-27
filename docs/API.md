# School ERP API — v1

Base URL: `/api/v1`

## Conventions

**Success**
```json
{ "success": true, "message": "OK", "data": { }, "meta": { "page": 1, "limit": 20, "total": 57, "totalPages": 3 } }
```
`meta` is present only on paginated lists.

**Error**
```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Validation failed", "details": [{ "field": "body.email", "message": "Invalid email address" }] } }
```

| HTTP | Typical `code` values |
|---|---|
| 401 | `UNAUTHORIZED`, `INVALID_TOKEN`, `TOKEN_EXPIRED`, `SESSION_REVOKED`, `INVALID_CREDENTIALS`, `INVALID_REFRESH_TOKEN`, `REFRESH_TOKEN_REUSED` |
| 403 | `FORBIDDEN`, `PERMISSION_DENIED`, `MODULE_NOT_ENABLED`, `SUBSCRIPTION_INACTIVE`, `PLAN_LIMIT_REACHED`, `PRIVILEGE_ESCALATION`, `OWNER_REQUIRED`, `SELF_MODIFICATION`, `CAMPUS_ACCESS_DENIED`, `NO_SCHOOL_SELECTED`, `TENANT_ACCESS_DENIED`, `ACCOUNT_DISABLED`, `PLATFORM_ADMIN_REQUIRED` |
| 404 | `NOT_FOUND` |
| 409 | `DUPLICATE`, `ALREADY_MEMBER`, `*_IN_USE` (`CAMPUS`, `ROLE`, `PLAN`, `MEMBER`, `SESSION`, `CLASS`, `SUBJECT`), `FAMILY_MEMBERSHIP` |
| 422 | `VALIDATION_ERROR` |
| 423 | `ACCOUNT_LOCKED` |
| 429 | `TOO_MANY_REQUESTS` |

**Pagination query:** `page` (≥1, default 1), `limit` (1–100, default 20).

**Authentication:** `Authorization: Bearer <accessToken>` (JWT, 15 min by default).

**Refresh tokens:** rotating, single-use, 30-day sessions.
- Web (`client: "web"`, default): refresh token is set as an `httpOnly`, `SameSite=Strict` cookie `erp_rt` scoped to `/api/v1/auth`. It is never returned in JSON. Call `/auth/refresh` with `credentials: 'include'`.
- Mobile (`client: "mobile"`): refresh token is returned in `data.refreshToken`; store it in secure storage and send it in the body.
- Replaying an already-used refresh token revokes the whole session (`REFRESH_TOKEN_REUSED`). Clients must serialize refresh calls (one in flight at a time).

## Multi-tenancy

- A user can belong to several schools (`Membership`). The active school is stored in the session and carried as a claim in the access token.
- The active school is chosen at login (automatic if the user has one school, or via `schoolId`), or with `POST /auth/select-school`.
- **Client-supplied school IDs (headers, query, body) are never used for tenant scoping.** On every school-scoped request the server re-verifies the membership and school status from the database.
- Platform super admins have **no implicit access** to school data.

---

## Auth — `/auth`

### `POST /auth/login` (public, rate-limited)
Body: `{ email, password, schoolId?, client?: "web"|"mobile" }`

Response `data`:
```json
{
  "accessToken": "…",
  "accessTokenExpiresIn": "15m",
  "refreshToken": "… (mobile only)",
  "user": { "id": "…", "name": "…", "email": "…", "phone": null, "platformRole": null, "status": "active", "isEmailVerified": true, "lastLoginAt": "…" },
  "schools": [{ "schoolId": "…", "name": "…", "code": "greenwood", "type": "school", "status": "active", "roles": ["teacher"] }],
  "tenant": { "schoolId": "…", "school": { }, "roles": ["teacher"], "campusIds": [], "permissions": ["attendance.mark", "…"] }
}
```
`tenant` is `null` when the user has several schools and no `schoolId` was given. Five failed attempts lock the account for 15 minutes (`423`).

### `POST /auth/refresh` (public)
Body: `{ client?: "web"|"mobile", refreshToken? }` (mobile sends `refreshToken`; web relies on the cookie).
Returns the same shape as login, with a new refresh token. The session's selected school is kept if the membership is still active.

### `POST /auth/select-school` 🔒
Body: `{ schoolId }`. Returns `{ accessToken, accessTokenExpiresIn, tenant }`. `403 TENANT_ACCESS_DENIED` without an active membership.

### `GET /auth/me` 🔒
Returns `{ user, schools, tenant, sessionId }`.

### `POST /auth/logout` 🔒
Revokes the current session and clears the cookie.

### `POST /auth/logout/refresh-token` (public)
Body: `{ refreshToken? }` or cookie. Logs out a session whose access token already expired.

### `POST /auth/logout-all` 🔒
Revokes every session of the user. Returns `{ sessionsRevoked }`.

### `GET /auth/sessions` 🔒
Lists active sessions: `[{ id, client, userAgent, ip, createdAt, lastUsedAt, expiresAt, current }]`.

### `DELETE /auth/sessions/:sessionId` 🔒
Revokes one of the user's own sessions.

### `POST /auth/change-password` 🔒
Body: `{ currentPassword, newPassword }`. Keeps the current session and revokes all others.

### `POST /auth/forgot-password` (public)
Body: `{ email }`. Always returns the same response. Sends a reset link to `${APP_URL}/reset-password?token=…`, valid for 1 hour.

### `POST /auth/reset-password` (public)
Body: `{ token, password }`. The token is single-use. Revokes all sessions, unlocks the account and marks the email verified.

### `POST /auth/resend-verification` 🔒
Sends a verification link to `${APP_URL}/verify-email?token=…`, valid for 24 hours. `data.delivered` is `false` when email (Brevo) is not configured (the email is logged, not sent).

### `POST /auth/verify-email` (public)
Body: `{ token }`.

Password policy: 8–128 characters, at least one letter and one number.

---

## Subscriptions, modules and effective permissions

- Every module permission `<module>.<action>` belongs to a module.
  - **Core modules** are always available: `school, campuses, users, roles, settings, subscription, audit, academics, calendar, students, parents, staff`.
  - **Plan modules** must be in the school's subscription: `admissions, attendance, timetable, fees, exams, homework, communication, reports`.
- **Effective permissions = role permissions ∩ enabled modules**, recalculated on every request. Plan changes, role edits and suspensions apply immediately.
- A subscription is usable while `trialing`, `active` or `past_due` and not past `currentPeriodEnd + graceDays`. After that its effective status is `expired`: plan modules are blocked, but core modules keep working so admins can still manage the account.
- Denials explain themselves:
  - `PERMISSION_DENIED`: the role doesn't grant the permission.
  - `MODULE_NOT_ENABLED`: the role grants it, but the plan doesn't include the module.
  - `SUBSCRIPTION_INACTIVE`: the subscription has lapsed.
- When a school assigns a plan, the plan's `modules` and `limits` are copied onto its subscription. Editing a plan later never changes what existing schools already have.
- Limits (`null` = unlimited):
  - `maxCampuses`: live campuses.
  - `maxUsers`: staff seats, meaning non-suspended members with a staff role or any custom role.
  - `maxStudents`: enforced from Phase 4.
  - Exceeding a limit returns `403 PLAN_LIMIT_REACHED` with `{ limit, max, used }`.

Tenant context (`tenant` in login/refresh/me, and `GET /context`):
```json
{
  "schoolId": "…", "school": { "name": "…", "code": "…", "type": "school", "status": "active", "timezone": "Asia/Kolkata", "currency": "INR" },
  "roles": ["school_admin"], "customRoles": [{ "id": "…", "key": "fee_clerk", "name": "Fee Clerk" }],
  "campusIds": [], "isOwner": false,
  "permissions": ["…effective…"], "modules": ["attendance", "campuses", "…"],
  "subscription": { "planCode": "standard", "planName": "Standard", "status": "trialing", "usable": true, "currentPeriodEnd": "…", "modules": ["…"], "limits": { "maxStudents": 1500, "maxCampuses": 3, "maxUsers": 75 } }
}
```

---

## School-scoped endpoints 🔒🏫
These require an access token **with a selected school**.

### `GET /context`
The verified tenant context (see above).

### School profile and settings
| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/school` | `school.read` | Profile + settings |
| PATCH | `/school` | `school.update` | `name, type, email, phone, address{…}, timezone, currency`. Nested partial updates. Only the platform can change `code` and `status`. |
| GET | `/school/settings` | `settings.read` | |
| PATCH | `/school/settings` | `settings.update` | `dateFormat (DD/MM/YYYY \| MM/DD/YYYY \| YYYY-MM-DD), weekStartsOn (0–6), academicYearStartMonth (1–12), branding{primaryColor #RRGGBB, logoUrl}` |

### Campuses
| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/campuses` | `campuses.read` | Query `page, limit, status, search`. Main campus first. Campus-restricted members see only their campuses. |
| POST | `/campuses` | `campuses.create` | `{ name, code, isMain?, status?, email?, phone?, address? }`. `code` is uppercased and unique within the school. Subject to `maxCampuses`. The first campus becomes main. |
| GET | `/campuses/:campusId` | `campuses.read` | `403 CAMPUS_ACCESS_DENIED` outside the member's campuses |
| PATCH | `/campuses/:campusId` | `campuses.update` | Setting `isMain: true` moves "main" here. The main campus can't be deactivated or unset. |
| DELETE | `/campuses/:campusId` | `campuses.delete` | Soft delete. Blocked for the main campus, and (`409 CAMPUS_IN_USE`) while it is some member's only campus or other modules still use it. |

Campus restriction: a membership with an empty `campusIds` list can access every campus. A non-empty list limits the member to those campuses. Restricted members can't create campuses and can only assign members to their own campuses.

### Roles
| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/roles` | `roles.read` | Built-in roles (`isSystem: true`, read-only) and custom roles, each with `memberCount` |
| GET | `/roles/permissions` | `roles.read` | Catalogue grouped by module: `{ module, label, core, enabled, permissions: [{ key, action, grantableByYou }] }` |
| POST | `/roles` | `roles.create` | `{ name, key (a-z0-9_), description?, permissions[] }`. Built-in keys are reserved. Max 50 per school. |
| GET | `/roles/:roleId` | `roles.read` | |
| PATCH | `/roles/:roleId` | `roles.update` | `{ name?, description?, permissions? }`. Applies to members immediately. |
| DELETE | `/roles/:roleId` | `roles.delete` | `409 ROLE_IN_USE` while assigned |

**Privilege-escalation guard (`403 PRIVILEGE_ESCALATION`):** you can only grant, revoke or delete permissions you hold yourself, and you can't manage a member whose permissions exceed yours.

### Members (staff)
| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/members` | `users.read` | Query `page, limit, role, customRoleId, campusId, status, search` |
| POST | `/members` | `users.create` | `{ name, email, phone?, roles[] (staff roles), customRoleIds[], campusIds[] }`. Existing users (matched by email) get a membership, are not renamed, and are emailed that they now have access (they sign in with their existing password). New users get an account-setup email (72 h link to `/reset-password?token=…&setup=1`). `data.emailDelivered` says whether the email was sent and `data.emailError` why not (`EMAIL_NOT_CONFIGURED` or the provider's error); a failed email never fails the request. `data.setupEmailDelivered` is the same for new users and `null` for existing ones. School onboarding and family logins behave the same way. Subject to `maxUsers`. |
| GET | `/members/:memberId` | `users.read` | |
| PATCH | `/members/:memberId` | `users.update` | `{ roles?, customRoleIds?, campusIds?, status? (active\|suspended) }` |
| DELETE | `/members/:memberId` | `users.delete` | Removes the membership (the user account remains) |

Member item: `{ id, roles, customRoleIds, campusIds, status, createdAt, user: { id, name, email, phone, status, isEmailVerified, lastLoginAt } }`

Rules:
- Only owners can grant or remove `school_owner` or change an owner (`OWNER_REQUIRED`).
- A school always keeps at least one active owner (`LAST_OWNER`).
- Nobody can change their own membership (`SELF_MODIFICATION`).
- `parent`/`student` roles are managed by the student and parent modules (Phase 4) and are preserved on update.
- Campus and role ids must belong to the school (`INVALID_CAMPUS`, `INVALID_ROLE`).

### Subscription (read-only for schools)
| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/subscription` | `subscription.read` | Summary + `usage` (`{ maxCampuses, maxUsers }`) + `modules: [{ key, label, included, enabled }]` |
| GET | `/subscription/plans` | `subscription.read` | Active plans for comparing upgrades |

Self-service upgrades and online subscription payments come with the Razorpay integration.

### Audit
`GET /audit-logs`, permission `audit.read`. Query: `page, limit, action, entityType, entityId`.
Actions include `auth.*`, `school.profile_updated`, `school.settings_updated`, `campus.created|updated|deleted`, `role.created|updated|deleted`, `member.added|updated|removed`, and the `platform.*` actions performed on this school.

---

## Academics — `/academics` 🔒🏫
Permissions: `academics.read` (all staff roles), `academics.create|update|delete` (admin, principal, owner).

**Model**
- **Sessions** are academic years. Exactly one per school is *current*; endpoints that take an optional `sessionId` default to it (`400 NO_CURRENT_SESSION` if there is none).
- **Classes** (grades) and **subjects** are defined once per school and reused every session.
- **Sections** belong to one session, class and campus, and can have a class teacher.
- **Class subjects** (the curriculum) and **teaching assignments** (teacher → section + subject) are set per session.
- A **closed** session is read-only (`400 SESSION_CLOSED`).
- Teachers are referenced by **membership id**. They must be active staff of the school (`INVALID_TEACHER`) with access to the section's campus (`TEACHER_CAMPUS_MISMATCH`).

**Dates** are sent as `YYYY-MM-DD` and returned as ISO timestamps at UTC midnight (e.g. `2026-04-01T00:00:00.000Z`). Use the date part.

### Sessions
| Method | Path | Notes |
|---|---|---|
| GET | `/academics/sessions` | Query `page, limit, status (planned\|active\|closed)`. Newest first. |
| GET | `/academics/sessions/current` | `404 NO_CURRENT_SESSION` if none |
| POST | `/academics/sessions` | `{ name, startDate, endDate, status? (planned\|active), isCurrent? }`. The school's first session becomes current automatically. Max length is two years. |
| GET / PATCH | `/academics/sessions/:id` | PATCH `{ name?, startDate?, endDate?, status? }`. The current session can't be closed or set back to planned (`CURRENT_SESSION`). Dates can't shrink past existing calendar events (`EVENTS_OUTSIDE_SESSION`). |
| POST | `/academics/sessions/:id/set-current` | Makes the session current (a planned session becomes active). Closed sessions are refused. |
| POST | `/academics/sessions/:id/copy-structure` | Year rollover: `{ fromSessionId, sections=true, classSubjects=true, teachers=false }`. Creates only what's missing, so it's safe to re-run. With `teachers`, class teachers and subject assignments are copied for members who are still active and still at that campus. Returns `{ sectionsCreated, classSubjectsCreated, assignmentsCreated, teachersSkipped }`. |
| DELETE | `/academics/sessions/:id` | Not the current session. `409 SESSION_IN_USE` while it has sections, mappings or calendar events. |

### Classes and subjects
| Method | Path | Notes |
|---|---|---|
| GET | `/academics/classes` | Query `page, limit (default 100), status, search`. Sorted by `order`. |
| POST | `/academics/classes` | `{ name, code, order, status?, description? }`. `code` is uppercased and unique among the school's live classes. |
| GET / PATCH / DELETE | `/academics/classes/:id` | Soft delete (frees the code). `409 CLASS_IN_USE` while it has sections or subject mappings. |
| GET | `/academics/subjects` | Query `page, limit, status, type, search` |
| POST | `/academics/subjects` | `{ name, code, type? (theory\|practical\|theory_practical\|activity), status?, description? }` |
| GET / PATCH / DELETE | `/academics/subjects/:id` | `409 SUBJECT_IN_USE` while mapped to a class |

Inactive classes can't get new sections (`CLASS_INACTIVE`). Inactive subjects can't be newly added to a class (`SUBJECT_INACTIVE`).

### Sections
| Method | Path | Notes |
|---|---|---|
| GET | `/academics/sections` | Query `sessionId?, classId?, campusId?, status?, page, limit (default 100)`. Ordered by class order, then name. Campus-restricted members see only their campuses. `meta.sessionId` echoes the session used. |
| POST | `/academics/sections` | `{ sessionId, classId, campusId, name, capacity?, room?, classTeacherId?, status? }`. `name` is uppercased. Unique per session + class + campus. |
| GET | `/academics/sections/:id` | |
| PATCH | `/academics/sections/:id` | `{ name?, capacity?, room?, classTeacherId? (null clears), status? }`. Session, class and campus can't be changed. |
| DELETE | `/academics/sections/:id` | Also removes its teaching assignments. Later modules (students, attendance) block deletion while in use. |

Section item: `{ _id, sessionId, classId, campusId, name, capacity, room, classTeacherId, status, class{ id, name, code, order }, campus{ id, name, code }, classTeacher{ id, name, email, status } | null, displayName: "Grade 1 - A" }`

### Curriculum and teachers
| Method | Path | Notes |
|---|---|---|
| GET | `/academics/class-subjects?classId=&sessionId=` | `{ sessionId, classId, subjects: [{ subjectId, isOptional, periodsPerWeek, order, subject{ name, code, type, status } }] }` |
| PUT | `/academics/class-subjects` | Replaces a class's subjects for a session: `{ sessionId, classId, subjects: [{ subjectId, isOptional?, periodsPerWeek?, order? }] }`. Removing a subject also removes its teaching assignments in that class's sections (`assignmentsRemoved`). |
| GET | `/academics/teaching-assignments` | Query `sessionId?, sectionId?, subjectId?, teacherId?, page, limit` |
| POST | `/academics/teaching-assignments` | `{ sectionId, subjectId, teacherId }`. The subject must be in the class curriculum (`SUBJECT_NOT_IN_CLASS`). Several teachers per subject is allowed; exact duplicates return `409`. |
| DELETE | `/academics/teaching-assignments/:id` | |
| GET | `/academics/my-assignments?sessionId=` | The signed-in staff member's `{ session, classTeacherOf: [section], subjects: [assignment] }` |
| GET | `/academics/structure?sessionId=&campusId=` | `{ session, classes: [{ id, name, code, order, subjectCount, sections: [{ id, name, campus, classTeacher, capacity, status }] }] }`, for selectors and setup screens |

Members who are still class teachers or subject teachers can't be removed from the school (`409 MEMBER_IN_USE`). Campuses with sections can't be deleted (`409 CAMPUS_IN_USE`).

## Academic calendar — `/calendar` 🔒🏫
Permissions: `calendar.read` (every role, including parents and students), `calendar.create|update|delete` (admin, principal, owner).

| Method | Path | Notes |
|---|---|---|
| GET | `/calendar` | Query `sessionId?, from?, to? (YYYY-MM-DD, range ≤ 400 days), type?, campusId?`. Returns events overlapping the range (default: the whole session) that apply to all campuses or to the given/caller's campuses. Response `{ session, from, to, items[] }`. |
| POST | `/calendar` | `{ sessionId, title, type? (holiday\|vacation\|event\|exam\|ptm\|other), startDate, endDate? (defaults to startDate), description?, campusIds? (empty = all campuses) }`. Dates must fall within the session (`OUTSIDE_SESSION`). |
| PATCH | `/calendar/:id` | Same fields except `sessionId` |
| DELETE | `/calendar/:id` | |

`holiday` and `vacation` events set `isNonWorking: true`. Attendance (Phase 5) uses them to skip non-working days. Campus-restricted members can only manage events limited to their own campuses.

## Who can see which students
- **Management roles** (owner, admin, principal, accountant) and members with a custom role see all students, limited to their campuses when campus-restricted.
- **Teachers** (members whose only staff role is `teacher`) see the students actively enrolled in sections they teach or are class teacher of in the current session, and those students' parents. Other student ids return `404`.
- **Parents and students** cannot use `/students` or `/parents`. They use `/portal`, which works from the record linked to their own login.
- **Later modules** (attendance, fees, exams, homework) limit family access with `familyStudentIds(tenant)` from `src/modules/students/access.js`.

## Students — `/students` 🔒🏫
Permissions: `students.read` (management roles, teachers), `students.create|update|delete` (admin, principal, owner).

**Model**
- **Student:** the person and their admission record.
  - `admissionNo` is unique among the school's students. It's generated as `ADM0001` when not given.
  - `status` is one of `active | inactive | alumni | transferred | withdrawn`. Only `active` students count toward the plan's `maxStudents` (`403 PLAN_LIMIT_REACHED`).
  - `campusId` is the home campus. It follows the student's current-session section.
- **Enrollment:** one per student per session (`ALREADY_ENROLLED`).
  - Links a student to a section and records the roll number.
  - `status` is one of `active | promoted | completed | left`.
  - Section capacity applies to active enrollments (`409 SECTION_FULL`).
  - Roll numbers are unique among a section's active students (`409 ROLL_NO_TAKEN`).

| Method | Path | Notes |
|---|---|---|
| GET | `/students` | Query `page, limit, search, sessionId?, classId?, sectionId?, campusId?, status?, gender?, enrolled? (true\|false), sort (name\|admissionNo\|createdAt, prefix - for descending)`. `search` matches name, admission number, student phone, or a **parent's phone**. Class/section filters use the given session (current by default). Rows: `{ _id, admissionNo, firstName, lastName, fullName, gender, dateOfBirth, status, campusId, phone, photoUrl, admissionDate, enrollment{ sectionId, classId, rollNo, displayName } \| null, primaryGuardian{ id, name, phone, relation } \| null, hasPortalAccess }` |
| GET | `/students/summary` | `{ session, byStatus{}, active, activeNotEnrolled }` |
| POST | `/students` | `{ firstName, lastName?, gender, dateOfBirth?, bloodGroup?, admissionNo?, admissionDate? (default today), campusId? (required without enrollment), status? (active\|inactive), phone?, email?, address?, nationality?, religion?, category?, previousSchool?, medicalNotes?, notes?, photoUrl?, enrollment?{ sectionId, rollNo? }, guardians?[ { guardianId } \| { guardian{ name, phone, email?, alternatePhone?, occupation?, address?, allowDuplicate? } }, plus relation, isPrimary?, receivesAlerts?, canPickup? ] }`. Everything is checked before anything is saved. If the section is on a different campus from `campusId` you get `ENROLLMENT_CAMPUS_MISMATCH`. |
| GET | `/students/:id` | Profile plus `campus`, `currentEnrollment`, `enrollments[]` (all sessions), `guardians[]` and `portal{ enabled, email, lastLoginAt }` |
| PATCH | `/students/:id` | Profile fields, `status`, `leftOn?`, `leavingReason?`. Changing to `alumni`, `transferred` or `withdrawn` ends active enrollments in open sessions (status `left`), which frees the seat. Reactivating checks the plan limit. `campusId` can't be changed while the student has a current section (`CAMPUS_FOLLOWS_ENROLLMENT`). |
| DELETE | `/students/:id` | For mistaken entries. Soft delete that removes enrollments, parent links and portal access, and frees the admission number. Later modules block deletion once attendance, fee or exam records exist (`STUDENT_IN_USE`); mark the student withdrawn instead. |
| POST | `/students/:id/enrollments` | `{ sectionId, rollNo? }`. The session comes from the section, which must be active and in an open session. A current-session enrollment moves the student's campus. |
| PATCH | `/students/enrollments/:enrollmentId` | `{ sectionId?, rollNo? (null clears), status? }`. A section change must stay within the same session (`SESSION_MISMATCH`) and clears the roll number unless a new one is given. |
| DELETE | `/students/enrollments/:enrollmentId` | Delete a mistaken enrollment (blocked once later modules reference it) |
| GET | `/students/sections/:sectionId/roster` | Active students ordered by roll number then name: `{ section{ id, displayName, capacity, ... }, count, items[{ enrollmentId, studentId, rollNo, admissionNo, name, gender, status }] }`. Teachers can only open their own sections (`SECTION_ACCESS_DENIED`). |
| POST | `/students/roll-numbers` | `{ sectionId, orderBy: name\|admissionNo }` numbers the section's active students 1..n. Returns the roster. |
| POST | `/students/promote` | `{ fromSectionId, toSectionId, studentIds[] (≤500) }`. The target section must be in a **later** session (`INVALID_PROMOTION`). Moved students' old enrollments become `promoted`. Returns `{ promoted, skipped[{ studentId, reason: NOT_IN_SOURCE_SECTION\|STUDENT_INACTIVE\|ALREADY_ENROLLED }] }`. Safe to re-run. |
| GET | `/students/:id/guardians` | The student's parents with relation and flags |
| POST | `/students/:id/guardians` | Link `{ guardianId }` or create `{ guardian{...} }` + `relation, isPrimary?, receivesAlerts?, canPickup?`. Max 6 per student. Needs `students.update` + `parents.update`. |
| PATCH | `/students/:id/guardians/:guardianId` | `{ relation?, isPrimary?, receivesAlerts?, canPickup? }`. Making one parent primary demotes the other. Removing primary directly is refused (`PRIMARY_REQUIRED`). |
| DELETE | `/students/:id/guardians/:guardianId` | Unlink. If the primary parent is removed, the next one becomes primary. |
| POST | `/students/:id/portal-access` | `{ email? }` (defaults to the student's email). Creates or links a login with the `student` role and sends an account-setup email to new users. Needs `students.update` + `users.create`. |
| DELETE | `/students/:id/portal-access` | Removes the `student` role (and the membership if it has no other role) |

## Parents — `/parents` 🔒🏫
Permissions: `parents.read` (management roles, teachers for their students' parents), `parents.create|update|delete` (admin, owner).

One parent record can be linked to several students (siblings). Each student marks one parent as the **primary** contact; that parent is shown in lists and contacted first for alerts.

| Method | Path | Notes |
|---|---|---|
| GET | `/parents` | Query `page, limit, search (name, email, phone), hasPortal?`. Rows include `children[{ studentId, name, admissionNo, status, relation, isPrimary, receivesAlerts, classSection }]` |
| POST | `/parents` | `{ name, phone, alternatePhone?, email?, occupation?, address?, notes?, allowDuplicate? }`. If a parent with the same phone already exists you get `409 DUPLICATE_GUARDIAN` with `details.matches`. Link the existing record instead, or resend with `allowDuplicate: true`. |
| GET / PATCH | `/parents/:id` | Detail includes `children[]` and `portal` |
| DELETE | `/parents/:id` | `409 GUARDIAN_IN_USE` while linked to students |
| POST | `/parents/:id/portal-access` | `{ email? }` (defaults to the parent's email, `EMAIL_REQUIRED` if none). Adds the `parent` role. A staff member who is also a parent keeps one membership with both roles. A login can represent only one parent or student record per school (`PORTAL_ACCOUNT_IN_USE`). Needs `parents.update` + `users.create`. |
| DELETE | `/parents/:id/portal-access` | Removes the `parent` role |

Staff members who also have a parent or student login can't be removed through `/members` (`FAMILY_MEMBERSHIP`). Revoke the portal access first.

## Family portal — `/portal` 🔒🏫
For signed-in parents and students. No ids are accepted: the records come from the caller's own login.

| Method | Path | Notes |
|---|---|---|
| GET | `/portal/children` | Parent only (`NOT_A_PARENT`). `{ parent, session, children[{ studentId, admissionNo, name, gender, dateOfBirth, status, relation, currentEnrollment{ displayName, rollNo, classTeacher{ name } } }] }` |
| GET | `/portal/student` | Student only (`NOT_A_STUDENT`). `{ session, student{ ...same card } }` |

## Admissions — `/admissions` 🔒🏫 (plan module)
Permissions: `admissions.read|create|update|delete` (admin, principal, owner). Schools whose plan doesn't include admissions get `403 MODULE_NOT_ENABLED`.

**Status flow** (`INVALID_STATUS_TRANSITION` otherwise; `details.allowed` lists valid next steps):
- `enquiry` → `applied`, `rejected` or `withdrawn`
- `applied` → `under_review`, `approved`, `rejected` or `withdrawn`
- `under_review` → `approved`, `rejected` or `withdrawn`
- `approved` → `under_review`, `rejected` or `withdrawn`
- `rejected` or `withdrawn` → `applied` (reopen)
- `enrolled` is reached only through the enroll action and is final.

| Method | Path | Notes |
|---|---|---|
| GET | `/admissions` | Query `page, limit, sessionId?, status?, classId?, campusId?, source?, followUpDue? (follow-up date today or earlier, open applications), search (application no, applicant, parent name or phone)` |
| GET | `/admissions/summary?sessionId=` | `{ byStatus{}, total }` |
| POST | `/admissions` | `{ sessionId, classId, campusId, applicant{ firstName, lastName?, gender, dateOfBirth?, previousSchool? }, guardian{ name, phone, email?, relation?, occupation? }, source? (walk_in\|phone\|website\|referral\|advertisement\|other), status? (enquiry\|applied), followUpDate?, notes? }`. `applicationNo` is generated (`APP00001`). |
| GET / PATCH | `/admissions/:id` | PATCH accepts partial `applicant` / `guardian` objects plus the other fields. Enrolled applications are read-only (`ADMISSION_ENROLLED`). |
| POST | `/admissions/:id/status` | `{ status, note? }`. Appends to `history` (last 50 entries). |
| POST | `/admissions/:id/enroll` | Approved applications only (`ADMISSION_NOT_APPROVED`). `{ sectionId? (must match the applied class and session: SECTION_MISMATCH), rollNo?, admissionNo?, admissionDate?, guardianId? (link an existing parent), allowDuplicateGuardian? }`. Creates the student through the same path as `POST /students` (plan limit, duplicate-parent check, capacity). Returns `{ admission, student }`. Needs `admissions.update` + `students.create`. |
| DELETE | `/admissions/:id` | Soft delete; not for enrolled applications |

## Staff — `/staff` 🔒🏫
Permissions: `staff.read` (admin, principal, owner), `staff.create` (+ `users.create`), `staff.update`.

Staff are members with a staff role or a custom role. Login, roles and campus access are managed through `/members`. `/staff` adds the **employee record**: code, department, designation, employment type and status, joining and exit dates, qualification, emergency contact.

| Method | Path | Notes |
|---|---|---|
| GET | `/staff` | Query `page, limit, search (name, email, phone, employee code, designation), role?, department?, employmentStatus? (active\|on_leave\|exited), status? (membership), campusId?`. Rows: `{ id (membership id), user{...}, roles, roleLabels, customRoleIds, campusIds, status, profile \| null }`. Campus-restricted callers see staff at their campuses plus staff with no campus restriction. |
| GET | `/staff/options` | `{ departments[], designations[] }` in use |
| POST | `/staff` | `{ name, email, phone?, roles[], customRoleIds[], campusIds[], profile{...} }`. Adds the member (new users get a setup email) and creates the employee record in one call. `employeeCode` is generated (`EMP0001`) when not given. If the record can't be saved, the new member is removed again. |
| GET | `/staff/:memberId` | Member, `profile`, and `teaching{ session, classTeacherOf[], subjects[] }` for the current session (`null` without one) |
| PUT | `/staff/:memberId/profile` | Create or update the employee record. Setting `employmentStatus: exited` records `exitDate` (today unless given). It does not remove access: suspend the member through `/members` for that. |

Removing a member through `/members` deletes their employee record (the audit log keeps the history).

## Attendance — `/attendance` 🔒🏫 (plan module)
Permissions:
- `attendance.read`: teachers, parents, students.
- `attendance.mark`: teachers, for their own sections and within the edit window.
- `attendance.update`: admin and principal, for any date in an open session.
- `attendance.reports`: admin and principal.

**Model:** daily attendance per section.
- An **AttendanceSheet** is the register for one section on one date.
- An **AttendanceRecord** holds one student's status for a day: `present | absent | late | leave`.
- Percentage = (present + late) ÷ days marked. Leave counts as a day marked but not attended.

**School settings** (`PATCH /school/settings` → `attendance`):
- `weeklyOffDays` (default `[0]`, Sunday)
- `teacherEditDays` (default `1`: today and yesterday)
- `absentAlerts` (default `true`)
- `alertOnLate` (default `false`)
- `lowAttendanceThreshold` (default `75`)

"Today" is the current date in the school's timezone.

**Rules when submitting:**
- The date must be in the section's session (`OUTSIDE_SESSION`) and not in the future (`FUTURE_DATE`).
- It must not be a weekly day off or a calendar holiday/vacation (`NON_WORKING_DAY`, where `details` has `reason` and `title`).
- The session must be open.
- Teachers can submit only for sections they teach or are class teacher of (`SECTION_ACCESS_DENIED`), and only within `teacherEditDays` (`ATTENDANCE_LOCKED`).

**Parent alerts**
- When today's register makes a student absent (or late, if enabled), each guardian with `receivesAlerts` gets a notification on every channel they have: `in_app` (they have a portal login) and `email`.
- Each alert has a unique dedupe key, so re-submitting or refreshing never sends it again.
- Changing a student from absent to something else cancels alerts that haven't gone out yet. An alert that was already sent stays sent.
- Backfilled (past) dates never alert.
- Students with no reachable guardian get a `failed` entry with `NO_GUARDIAN` or `NO_CONTACT_CHANNEL`, so the school can see who wasn't informed.
- Emails fail with `EMAIL_NOT_CONFIGURED` until Brevo is set up. Alerts also go by SMS, WhatsApp and push on the school's alert channels once those are configured (see Communication).

| Method | Path | Notes |
|---|---|---|
| GET | `/attendance/daily?date=&campusId=` | Dashboard for the sections the caller can see. Returns:<ul><li>`day` (`isWorkingDay`, `reason`, `title`)</li><li>`totals` (`enrolled`, `sections`, `markedSections`, `total`, `present`, `absent`, `late`, `leave`, `percentage`)</li><li>`classes[]` (class-wise summary)</li><li>`sections[]` (`marked`, `counts`, `percentage`)</li><li>`unmarked[]`</li><li>`alerts` (counts by status)</li></ul>Needs mark, update or reports. |
| GET | `/attendance/sections/:sectionId?date=` | The register (today by default). Returns `day`, `sheet` (counts, marked by/at, submissions) or `null`, `canEdit`, `lockedReason`, and `students[]` (rollNo, name, status, remark, `onApprovedLeave`, `suggestedStatus`). |
| PUT | `/attendance/sections/:sectionId` | `{ date, defaultStatus?, entries[{ studentId, status, remark? }] }`. Every active student needs a status, taken in this order: the entry, then approved leave, then `defaultStatus` ("mark all present"). Otherwise `ATTENDANCE_INCOMPLETE` with `details.missing`. Students not in the section return `STUDENT_NOT_IN_SECTION`. Safe to re-submit. Returns the register plus `result{ created, changed, alertsQueued }`. |
| GET | `/attendance/sections/:sectionId/register?month=YYYY-MM` | Month grid: `days[{ date, weekday, isWorkingDay, marked }]` and `students[{ rollNo, name, days{ 'YYYY-MM-DD': status }, totals{..., percentage} }]` |
| GET | `/attendance/students/:studentId?sessionId=&from=&to=` | `{ student, session, from, to, summary{ total, present, absent, late, leave, percentage }, threshold, records[] }`. Defaults to the session start until today. Teachers see only their students; parents only their children. |
| GET | `/attendance/reports/low` | Query `sessionId?, classId?, sectionId?, threshold? (default from settings), minDays?, page, limit`. Students below the threshold, lowest first, with `primaryGuardian{ name, phone }`. |
| GET | `/attendance/alerts?date=&status=&sectionId=` | Delivery log for parent alerts: channel, recipient, status, error, student |
| GET | `/attendance/leave-requests` | Query `status?, studentId?, sectionId?, page, limit`. Limited to students the caller can see. |
| POST | `/attendance/leave-requests` | Staff record leave for a student: `{ studentId, fromDate, toDate, reason }` (max 60 days). Created **approved**. |
| POST | `/attendance/leave-requests/:id/review` | `{ status: approved\|rejected, note? }`. Pending requests only (`LEAVE_NOT_PENDING`). Approving converts absences already marked in the range to `leave` (`recordsConverted`) and cancels unsent absence alerts. |
| POST | `/attendance/leave-requests/:id/cancel` | Pending requests, or approved ones that haven't started (`LEAVE_STARTED`) |

Students with attendance records can't be deleted (`STUDENT_IN_USE`). Sections and sessions with registers can't be deleted.

## Timetable — `/timetable` 🔒🏫 (plan module)
Permissions: `timetable.read` (staff, parents, students), `timetable.create|update|delete` (admin, principal, owner).

- **Bell schedule:** the periods of the day (`number`, `label`, `startTime`, `endTime` as `HH:mm`, `isBreak`) and `workingDays` (0 = Sunday … 6 = Saturday), per session.
  - `campusId: null` is the school default. A campus schedule overrides it for that campus.
  - Periods can't overlap.
- **Timetable entry:** a section's subject in a period on a weekday, with an optional teacher and room.

| Method | Path | Notes |
|---|---|---|
| GET | `/timetable/bell-schedules?sessionId=` | `{ session, items[] }` |
| POST | `/timetable/bell-schedules` | `{ sessionId, campusId?, name, workingDays? (default Mon–Sat), periods[] }`. One per session and campus (`SCHEDULE_EXISTS`). Campus-restricted members can't set the school default. |
| PATCH / DELETE | `/timetable/bell-schedules/:id` | Removing a period or day that timetables use is refused (`PERIOD_IN_USE`, `DAY_IN_USE`). So is deleting a schedule in use (`SCHEDULE_IN_USE`). |
| GET | `/timetable/sections/:sectionId` | `{ section, schedule, entries[{ day, dayName, periodNumber, subject, teacher, room }] }` |
| PUT | `/timetable/sections/:sectionId` | Replaces the week: `{ entries[{ day, periodNumber, subjectId, teacherId?, room? }] }`. Each entry must use a working day (`INVALID_DAY`) and a teaching period (`INVALID_PERIOD`), and its subject must be in the class curriculum (`SUBJECT_NOT_IN_CLASS`). A teacher must be assigned to that subject in the section (`TEACHER_NOT_ASSIGNED`) and must be free in that period (`409 TEACHER_CLASH`, where `details.clashes` names the other class). `NO_BELL_SCHEDULE` if the session has none. |
| GET | `/timetable/my?day=` | The signed-in teacher's week, or one day (`0–6` or `today`), with period times |
| GET | `/timetable/teachers/:memberId?day=` | Another teacher's timetable (needs `timetable.update`) |

Removing a subject from a class curriculum also removes it from that class's timetables. A teaching assignment used in a timetable can't be deleted (`TEACHING_ASSIGNMENT_IN_USE`).

## Family portal additions (Phase 5)
For parents with several children, pass `studentId`. With one child it can be omitted. Children outside the caller's family return `404`. A staff member who is also a parent sees exactly what other parents see here.

| Method | Path | Notes |
|---|---|---|
| GET | `/portal/attendance?studentId=&from=&to=` | Same shape as `/attendance/students/:id` |
| GET / POST | `/portal/leave-requests` | POST `{ studentId, fromDate, toDate, reason }` creates a **pending** request. Past dates are refused (`PAST_LEAVE`). |
| POST | `/portal/leave-requests/:id/cancel` | Own requests only |
| GET | `/portal/timetable?studentId=` | The child's current section timetable |
| GET | `/portal/notifications?unread=` | In-app inbox; `meta.unread` is the unread count |
| POST | `/portal/notifications/:id/read`, `/portal/notifications/read-all` | |

## Fees and payments — `/fees` 🔒🏫 (plan module)
Permissions:
- **Accountant, admin, owner:** `fees.*`.
- **Principal:** `fees.read` and `fees.reports`.
- **Parents:** `fees.read`, used only through `/portal/fees`.

| Permission | Covers |
|---|---|
| `fees.read` | Lists, receipts, dashboard |
| `fees.create` | Setup, assigning fees, ad-hoc invoices |
| `fees.update` | Concessions, late fees, reminders |
| `fees.delete` | Cancelling invoices and assignments |
| `fees.collect` | Taking payments |
| `fees.refund` | Refunds |
| `fees.reports` | Defaulters and reports |

**Money and safety**
- **Amounts** are whole numbers in the smallest unit (paise): `150000` = ₹1,500.00. Fractions are rejected.
- **Every write is all-or-nothing.** Fee writes (assigning, invoicing, payments, refunds) run in MongoDB transactions and refuse to run without a replica set (`503 TRANSACTIONS_UNAVAILABLE`).
- **Issued invoices are frozen.** They snapshot the fee lines, discounts, class/section and late-fee rule. Editing a structure later changes only future assignments.
- **No overpaying.** Payments are applied with a balance check inside the transaction, so two people collecting at once can't overpay an invoice (`409 BALANCE_CHANGED`).
- **Accounting foundation:** every payment and refund posts balanced double-entry journal lines (`CASH` / `BANK` / `GATEWAY` against `FEE_INCOME` per category, late fee as its own line, `ADVANCE` for money not owed on any invoice). The journal is append-only.
- **Invoice badges** (`displayStatus`): `pending`, `partially_paid`, `paid`, `overdue` (balance left after the due date) or `cancelled`. Stored `status` is `unpaid | partially_paid | paid | cancelled`.
- **Numbering:** `INV000001`, `RCT000001` and `RFD000001`, per school, with no gaps.

### Setup
| Method | Path | Notes |
|---|---|---|
| GET / POST | `/fees/categories` | `{ name, code, description?, status? }`. `CODE_TAKEN` on duplicates. |
| PATCH / DELETE | `/fees/categories/:id` | Delete is refused while used (`CATEGORY_IN_USE`); mark it inactive instead |
| GET | `/fees/structures?sessionId=&classId=&status=` | Includes installment totals, `totalAmount` and `assignedStudents` |
| POST | `/fees/structures` | `{ sessionId, name, classIds[], campusId? (null = all), installments[{ name, dueDate, items[{ categoryId, amount }] }] (1–24), lateFee?{ type: none\|fixed\|per_day, amount, graceDays, maxAmount (0 = no cap) }, status? }`. Due dates must be inside the session (`OUTSIDE_SESSION`). |
| GET / PATCH / DELETE | `/fees/structures/:id` | Delete only if never assigned (`STRUCTURE_IN_USE`) |
| GET / POST | `/fees/discounts` | `{ name, type: percent\|fixed, value, categoryIds? (empty = all), description? }`. A `fixed` value is taken off each matching line of each installment. |
| PATCH / DELETE | `/fees/discounts/:id` | `DISCOUNT_IN_USE` once given to students |

### Assigning and invoices
| Method | Path | Notes |
|---|---|---|
| POST | `/fees/assignments` | `{ structureId, studentIds[] \| sectionId, discountIds[] }`. Creates one invoice per installment for each eligible student, one transaction per student. Returns `{ assigned, invoicesCreated, skipped[{ studentId, reason }] }`. Skip reasons: `NOT_ENROLLED_IN_SESSION`, `CLASS_NOT_IN_STRUCTURE`, `CAMPUS_MISMATCH`, `STUDENT_INACTIVE`, `ALREADY_ASSIGNED`. |
| GET | `/fees/assignments?structureId=&studentId=&status=` | |
| POST | `/fees/assignments/:id/cancel` | `{ reason }`. Cancels its invoices. Refused if any has a payment (`ASSIGNMENT_HAS_PAYMENTS`). |
| GET | `/fees/invoices` | Query:<ul><li>`search`: invoice no, student name or admission no, parent name or phone</li><li>`sessionId, classId, sectionId, studentId`</li><li>`status`: `unpaid`, `partially_paid`, `paid`, `cancelled`, `overdue`, `pending` or `outstanding`</li><li>`dueFrom, dueTo, sort, page, limit`</li></ul>`meta.amounts` gives `{ total, paid, balance }` for the whole filter. |
| POST | `/fees/invoices` | Ad-hoc invoice (fine, exam fee): `{ studentId, title, dueDate, lines[{ categoryId, amount, description? }] }`, in the current session |
| GET | `/fees/invoices/:id` | Lines with `net`, late-fee rule, primary guardian, `payments[]` and `refunds[]` |
| POST | `/fees/invoices/:id/cancel` | `{ reason }`. Only invoices without payments (`INVOICE_HAS_PAYMENTS`). |
| POST | `/fees/invoices/:id/concession` | `{ amount, reason }`. Reduces what is owed, at most the balance (`CONCESSION_TOO_HIGH`). |
| POST | `/fees/invoices/:id/waive-late-fee` | `{ reason }` (`NO_LATE_FEE`, `LATE_FEE_PAID`) |
| POST | `/fees/invoices/:id/remind` | Sends a reminder now. Once per invoice per day (`ALREADY_REMINDED_TODAY`). |
| POST | `/fees/late-fees/apply` | Brings late fees up to date now. This also runs hourly. Fees only increase, stop at the cap, and never apply to paid, cancelled or waived invoices. |
| GET | `/fees/students/:id` | A student's fee account: `summary{ total, paid, balance, overdue, nextDue }`, `invoices[]`, `payments[]` |

### Payments and refunds
| Method | Path | Notes |
|---|---|---|
| POST | `/fees/payments` | `{ studentId, allocations[{ invoiceId, amount }] \| amount, method: cash\|cheque\|bank_transfer\|upi\|card\|other, reference? (required for cheque, bank transfer, UPI and card), notes?, paidAt? (not in the future), idempotencyKey? }`. A plain `amount` pays the oldest due invoices first. Errors: `AMOUNT_EXCEEDS_BALANCE`, `INVALID_INVOICE`. Re-sending the same `idempotencyKey` returns the original receipt with `replayed: true` (HTTP 200) instead of charging twice. Returns the **receipt**. |
| GET | `/fees/payments` | Query `from, to, method, source (offline\|online), status, studentId, search (receipt no), page, limit` |
| GET | `/fees/payments/:id/receipt` | `{ receiptNo, paidAt, school{...}, student{ name, admissionNo, classSection }, method, reference, items[{ invoiceNo, title, amount, balanceAfter }], amount, amountInWords, refunds[], collectedBy, status }` |
| POST | `/fees/payments/:id/refund` | `{ amount, reason, method? (required for offline payments), reference? }`. Advance money is returned first, then invoices from the last one backwards, and those invoices become payable again. Online payments are refunded through Razorpay. `REFUND_EXCEEDS_PAYMENT` if too much. |

### Online payments (Razorpay)
Each school connects **its own** Razorpay account, so fees go straight to the school.
- Key secrets are encrypted at rest with `DATA_ENCRYPTION_KEY` and are never returned.
- Enable **auto-capture** in Razorpay.
- Point the Razorpay webhook (events `payment.captured`, `order.paid`) at `/api/v1/webhooks/razorpay/<schoolId>`, using the same webhook secret saved here.

| Method | Path | Notes |
|---|---|---|
| GET | `/fees/gateway` | `{ configured, enabled, keyId, webhookConfigured, webhookPath }` |
| PUT | `/fees/gateway` | `{ keyId: rzp_test_…\|rzp_live_…, keySecret, webhookSecret?, enabled? }`. Needs `fees.update` + `settings.update` (admin, owner). |
| POST | `/webhooks/razorpay/:schoolId` | Public endpoint, authenticated by `X-Razorpay-Signature` over the raw body. Records the payment once, keyed on the Razorpay payment id. If an invoice was meanwhile paid at the counter, the extra is held as advance (`unallocatedAmount`), which can be refunded. |

### Automated fee reminders
- Rules are relative to the due date: days before (e.g. 3 and 1), on the day, and days after (e.g. 3 and 7) while unpaid.
- Reminders go to every guardian who receives alerts, on each configured channel they can be reached on: `in_app`, `email`, `sms`, `whatsapp`, `push` (see Communication).
- Each invoice + rule + guardian + channel is sent at most once.
- The scheduler checks hourly and sends from `sendHour` in the school's timezone.
- Students with no reachable guardian are recorded as `failed` (`NO_GUARDIAN` / `NO_CONTACT_CHANNEL`).
- Email shows as `failed: EMAIL_NOT_CONFIGURED` until Brevo is set up. SMS, WhatsApp and push can be chosen once configured on the server. Wording comes from the school's message templates.

| Method | Path | Notes |
|---|---|---|
| GET | `/fees/reminders` | `{ settings, channels[{ channel, label, available }], upcoming[{ date, rule, invoices }] (next 7 days), last30Days{ byStatus, byChannel }, recent[] }` |
| PATCH | `/fees/reminders/settings` | `{ enabled?, beforeDays?, onDueDate?, afterDays?, channels? (in_app\|email\|sms\|whatsapp\|push), sendHour? }`. Off by default. |
| POST | `/fees/reminders/run` | Runs today's rules now (safe to repeat) |

### Reports
| Method | Path | Notes |
|---|---|---|
| GET | `/fees/dashboard` | Returns:<ul><li>`collection{ today, month{ amount, refunds, net }, online, offline }`</li><li>`outstanding`</li><li>`overdue{ amount, invoices, students }`</li><li>`recentPayments[]`</li><li>`upcomingDue[]` (next 7 days)</li><li>`reminders` (last 30 days by status)</li></ul>"Today" uses the school's timezone. |
| GET | `/fees/defaulters` | Query `sessionId?, classId?, sectionId?, minAmount?, page, limit`. Students with overdue balances, largest first, with `oldestDueDate`, `daysOverdue` and `primaryGuardian`. |
| GET | `/fees/reports/collections?from=&to=&groupBy=` | `groupBy` is one of:<ul><li>`day` / `method`: gross receipts</li><li>`category`: net income from the journal, with a late-fee row</li><li>`class`</li></ul>`totals{ received, payments, refunded, net }` |
| GET | `/fees/reports/outstanding?sessionId=` | Balance and overdue amount by class |
| GET | `/fees/reports/ledger?from=&to=&account=` | Journal lines (day book) with `meta.byAccount` debit/credit totals |

Students with invoices or payments can't be deleted (`STUDENT_IN_USE`). Sessions, classes, sections and campuses used by fee records are protected too.

### Family portal: fees
| Method | Path | Notes |
|---|---|---|
| GET | `/portal/fees?studentId=` | The child's fee account plus `onlinePayment.available` |
| GET | `/portal/fees/payments/:id/receipt` | Only for the family's own children |
| POST | `/portal/fees/orders` | `{ studentId?, invoiceIds[] }`. Creates a Razorpay order for the current balances (the amount is computed on the server). Returns `{ orderId, keyId, amount, currency, schoolName, invoices }` for Razorpay Checkout. `503 PAYMENTS_NOT_CONFIGURED` if the school hasn't connected Razorpay. |
| POST | `/portal/fees/orders/verify` | `{ orderId, paymentId, signature }` from Checkout. Verifies the signature (`INVALID_SIGNATURE`) and returns the receipt. Safe to call more than once; the webhook records the same payment only once. |

## Examinations and results — `/exams` 🔒🏫 (plan module)
Permissions:
- `exams.read`: staff, parents, students.
- `exams.create|update|delete`: admin, principal.
- `exams.marks`: teachers, for subjects they teach.
- `exams.publish`: admin, principal.

`/exams` is for staff only (`403 STAFF_ONLY`). Parents and students use `/portal` and only ever see **published** results.

**Model**
- **Grading scale:** percentage bands, each with a grade, `minPercent` and an optional `gradePoint`. Bands are sorted high → low and the lowest must start at 0. The school's first scale becomes its default, and exams without their own scale use the default.
- **Exam:** for some classes of a session, with dates and a `weightage` used for the session report card. It's either `draft` or `published`. `marksLocked` stops teachers from entering marks.
- **Paper:** one per class and subject in an exam, with a date, optional times, `maxMarks` and `passMarks`.
- **Marks:** one per student per paper, with a status of `present` (marks required), `absent` (counts as 0 and a failed subject) or `exempt` (left out of totals). Marks allow up to two decimals.
- **Result:**
  - `total / maxTotal`, `percentage`, and grade from the scale.
  - `result` is `pass`, `fail` (a subject is below its pass marks, or absent) or `incomplete` (a paper has no entry).
  - Ranks within the section and within the class use competition ranking (1, 2, 2, 4). Incomplete results aren't ranked.
- **Publishing** stores a frozen snapshot of every result, so what families see never changes silently. Unpublishing deletes the snapshot and returns the exam to draft (marks stay locked).

| Method | Path | Notes |
|---|---|---|
| GET / POST | `/exams/grading-scales` | `{ name, bands[{ grade, minPercent, gradePoint?, remark? }], isDefault? }` |
| PATCH / DELETE | `/exams/grading-scales/:id` | Bands can't change while published results use the scale, and a scale used by exams can't be deleted (`SCALE_IN_USE`). There must always be a default (`DEFAULT_REQUIRED`). |
| GET | `/exams?sessionId=&classId=&status=&type=` | `{ session, items[{ ..., classes[], gradingScale, paperCount }] }` |
| POST | `/exams` | `{ sessionId, name, type? (unit_test\|term\|final\|other), classIds[], startDate, endDate, gradingScaleId?, weightage? (0–100, default 100), description? }` |
| GET / PATCH / DELETE | `/exams/:id` | GET includes `papers[]`. PATCH and DELETE only in draft (`EXAM_PUBLISHED`). New dates can't strand papers (`PAPERS_OUTSIDE_DATES`), and a removed class can't still have papers (`CLASS_HAS_PAPERS`). DELETE is refused once marks exist (`EXAM_IN_USE`). |
| GET | `/exams/:id/papers?classId=` | |
| PUT | `/exams/:id/papers` | Replaces one class's papers: `{ classId, papers[{ subjectId, date, startTime?, endTime?, maxMarks, passMarks, room? }] }`. Errors:<ul><li>`SUBJECT_NOT_IN_CLASS`: subject not in the curriculum</li><li>`OUTSIDE_EXAM_DATES`: date outside the exam</li><li>`PAPER_CLASH`: overlaps another paper of the class</li><li>`PAPER_HAS_MARKS`: removing a paper that has marks</li><li>`MARKS_EXCEED_MAX`: lowering the maximum below marks already entered</li></ul> |
| GET | `/exams/:id/papers/:paperId/marks?sectionId=` | Marks sheet: `{ paper{ subject, maxMarks, passMarks }, section, canEdit, lockedReason, entered, total, students[{ rollNo, name, marks, status, remarks }] }`. Teachers can open only their own sections. |
| PUT | `/exams/:id/papers/:paperId/marks` | `{ sectionId, entries[{ studentId, marks?, status?, remarks? }] }` for bulk entry; safe to re-submit. Managers can edit until publication. Teachers can edit only their subject in their section (`NOT_SUBJECT_TEACHER`) and only while unlocked (`MARKS_LOCKED`). Corrections are recorded in the audit log. |
| GET | `/exams/:id/progress` | Marks entered per section and paper, plus `complete` |
| POST | `/exams/:id/lock`, `/exams/:id/unlock` | Stop or allow marks entry by teachers |
| GET | `/exams/:id/results?sectionId=` | Live preview in draft (`preview: true`), or the published snapshot. Includes `summary{ students, pass, fail, incomplete, average }`. |
| PUT | `/exams/:id/remarks` | `{ sectionId, entries[{ studentId, remark }] }` (an empty remark clears it). Class teacher or manager, draft only (`NOT_CLASS_TEACHER`). |
| POST | `/exams/:id/publish` | `{ allowIncomplete? }`. Refused while marks are missing (`409 MARKS_INCOMPLETE`, where `details.students[].missing` lists the subjects) unless allowed. Stores the snapshot, locks marks, and notifies parents (receiving alerts) and students with a login, once per exam. Returns `{ students, pass, fail, incomplete, notificationsQueued }`. |
| POST | `/exams/:id/unpublish` | `{ reason }` |
| GET | `/exams/:id/report-cards/:studentId` | Report card for one exam (a draft is a staff preview): school, student, exam, subjects with marks and grade, totals, ranks, remark, session attendance, grading scale |
| GET | `/exams/students/:studentId/results?sessionId=` | The student's published results in a session |
| GET | `/exams/students/:studentId/report-card?sessionId=` | Session report card: published exams combined by weightage. Each subject is a weighted average over the exams that assessed it. Uses the default scale. |

Sessions, classes, subjects, sections, students and enrollments used by exams can't be deleted. A subject with exam papers can't be removed from a class curriculum (`CLASS_SUBJECTS_IN_USE`).

### Family portal: exams
| Method | Path | Notes |
|---|---|---|
| GET | `/portal/exams?studentId=` | Exams of the child's class with paper schedule |
| GET | `/portal/results?studentId=&sessionId=` | Published results |
| GET | `/portal/results/:examId?studentId=` | Published report card (`404` until published) |
| GET | `/portal/report-card?studentId=&sessionId=` | Session report card from published exams |

## Campus services (Phase 10) 🔒🏫 (plan modules)
Each of `library`, `hr`, `inventory` and `hostel` is a separate plan module (`403 MODULE_NOT_ENABLED` when the plan lacks it). Desk endpoints are for staff only (`STAFF_ONLY`). Families use `/portal/library` and `/portal/hostel`.

Plans copy their modules onto a school's subscription when assigned. For schools created before Phase 10, add the new modules with `PATCH /platform/schools/:id/subscription { modules }`.

### Library — `/library`
Permissions:
- `library.read`: staff, parents, students.
- `library.issue`: the library desk (`staff` role), plus admin and principal.
- `library.create|update|delete`: admin, principal.

| Method | Path | Notes |
|---|---|---|
| GET / PATCH | `/library/settings` | `{ loanDays (14), maxBooksStudent (3), maxBooksStaff (5), finePerDay (paise, 100), maxFine (paise, null = no cap), fineCategoryId }`. A late return is fined `min(finePerDay × days late, maxFine)`. |
| GET | `/library/summary` | `{ titles, copies, available, onLoan, overdue, pendingFines{ amount, count } }` |
| GET / POST | `/library/books` | Query `search, category, available, status, page, limit`. POST `{ title, author?, isbn?, publisher?, category?, edition?, shelf?, copies }` |
| PATCH / DELETE | `/library/books/:id` | Changing `copies` keeps copies on loan: available changes by the same amount, and the total can't drop below copies on loan (`COPIES_ON_LOAN`). Deleting needs no copies on loan (`BOOK_ON_LOAN`). |
| GET | `/library/issues` | Query `status (issued\|overdue\|returned\|lost), fineStatus, studentId, membershipId, bookId`. Rows include `book`, `borrower`, `overdueDays` and `displayStatus`. |
| POST | `/library/issues` | `{ bookId, studentId \| membershipId, dueDate?, note? }`. The copy is reserved atomically (`NO_COPIES_AVAILABLE`). Also checks the borrower's limit (`BORROW_LIMIT`) and duplicates (`ALREADY_BORROWED`). The due date defaults to today + `loanDays`. |
| POST | `/library/issues/:id/return` | `{ waiveFine?, note? }`. A late return records `finePerDay × days late` with `fineStatus: pending`. `waiveFine: true` also needs `library.update` (403 otherwise). |
| POST | `/library/issues/:id/lost` | `{ charge?, note? }`. The copy leaves the collection, and the charge becomes the fine. |
| POST | `/library/issues/:id/waive-fine` | `{ reason }` |
| POST | `/library/issues/:id/charge-fine` | Adds a student's pending fine to their fees as a one-off invoice, using the configured fine category. Needs the fees module (and transactions). |
| GET | `/portal/library?studentId=` | Family: `{ current[], history[] }` |

### Inventory — `/inventory`
Permissions:
- `inventory.read`: admin, principal, accountant, staff.
- `inventory.create|update|delete`: admin, accountant.

| Method | Path | Notes |
|---|---|---|
| GET / POST | `/inventory/items` | Query `search, category, lowStock, status`. POST `{ name, code, category?, unit?, reorderLevel?, location?, openingQuantity? }`. `meta.lowStockCount` counts items at or below their reorder level. |
| PATCH / DELETE | `/inventory/items/:id` | Delete needs zero stock (`ITEM_HAS_STOCK`) |
| POST | `/inventory/items/:id/movements` | `{ type: in\|out\|adjust, quantity (in/out), countedQuantity (adjust), unitCost?, reference?, issuedTo?, note (required for adjust) }`. Stock changes atomically and never goes negative (`INSUFFICIENT_STOCK`). An adjustment fails if stock changed meanwhile (`STOCK_CHANGED`). Returns `{ item, movement }`. |
| GET | `/inventory/movements?itemId=&type=` | Append-only stock history, with `balanceAfter` on each line |

### Hostel — `/hostels`
Permissions:
- `hostel.read`: admin, principal, parents, students.
- `hostel.create|update|delete`: admin, principal.

| Method | Path | Notes |
|---|---|---|
| GET / POST | `/hostels` | GET returns hostels with `rooms[]`, `capacity`, `occupied` and `warden`. POST `{ name, type: boys\|girls\|mixed, wardenId?, address? }` |
| PATCH / DELETE | `/hostels/:id` | Delete needs no rooms |
| POST | `/hostels/:id/rooms` | `{ number, floor?, capacity }` |
| PATCH / DELETE | `/hostels/rooms/:id` | Capacity can't drop below current occupancy. An occupied room, or one with history, can't be deleted. |
| GET | `/hostels/allocations/list` | Query `status (active\|ended), hostelId, roomId, studentId` |
| POST | `/hostels/allocations` | `{ studentId, roomId, fromDate?, note? }`. The bed is reserved atomically (`ROOM_FULL`). One active room per student (`ALREADY_ALLOCATED`). Boys and girls hostels take matching students only (`HOSTEL_GENDER_MISMATCH`). |
| POST | `/hostels/allocations/:id/vacate` | `{ toDate?, note? }` |
| GET | `/portal/hostel?studentId=` | Family: `{ allocation{ hostel, room, fromDate, warden } \| null }` |

### HR and payroll — `/hr`
Permissions:
- `hr.self`: every staff member.
- `hr.read`: admin, principal, accountant.
- `hr.update`: admin, principal.
- `hr.payroll`: admin, accountant.

**Leave**
- **Leave days** are working days, so the school's weekly days off are excluded.
- **Quotas** (casual, sick, earned, and optionally other) apply per academic session, or per calendar year when there's no session. Pending requests count against the balance (`INSUFFICIENT_LEAVE`).
- **Unpaid leave** has no limit and is deducted in payroll.
- **No self-approval:** a manager can't approve their own leave (`SELF_APPROVAL`).

**Payroll**
- **Payslips** are snapshots: basic + allowances − fixed deductions − unpaid-leave deduction (`gross × unpaid days ÷ days in month`).
- **Exited staff** are skipped.
- **Statuses:** `draft` (recalculate as often as needed), then `finalized` (staff can see payslips), then `paid`. Marking paid posts Dr `SALARY_EXPENSE` / Cr `BANK` or `CASH` in one transaction.

| Method | Path | Notes |
|---|---|---|
| GET | `/hr/my/leave-balance` | `{ year, types[{ type, quota, taken, pending, available }] }` |
| GET / POST | `/hr/my/leaves` | POST `{ type, fromDate, toDate, reason }`. Errors: `LEAVE_OVERLAP`, `NO_WORKING_DAYS`. |
| POST | `/hr/my/leaves/:id/cancel` | Approved leave only before it starts |
| GET | `/hr/my/payslips`, `/hr/my/payslips/:id` | Finalized and paid payslips only |
| GET / PATCH | `/hr/settings` | `{ leaveQuota{ casual, sick, earned, other } }` |
| GET | `/hr/leaves?status=&membershipId=` | |
| GET | `/hr/leave-balance/:membershipId` | |
| POST | `/hr/leaves/:id/review` | `{ status: approved\|rejected, note? }` |
| GET | `/hr/salaries` | Staff with salary, monthly gross and net |
| PUT | `/hr/salaries/:membershipId` | `{ basic, allowances[{ name, amount }], deductions[{ name, amount }], bankAccount? }` (paise) |
| GET / POST | `/hr/payroll` | POST `{ month: YYYY-MM }` prepares a draft (`RUN_EXISTS` if the month already has one) |
| GET / DELETE | `/hr/payroll/:id` | Run with `payslips[]`. Only drafts can be deleted. |
| POST | `/hr/payroll/:id/recalculate`, `/finalize` | Draft only (`RUN_NOT_DRAFT`) |
| POST | `/hr/payroll/:id/pay` | `{ method: bank_transfer\|cash\|cheque, paidAt?, reference? }`. Finalized runs only. Needs transactions (`503 TRANSACTIONS_UNAVAILABLE`). |
| GET | `/hr/payslips/:id` | Any payslip (payroll staff) |

## Communication and notifications (Phase 11) 🔒🏫 (plan module `communication`)

### Delivery channels
Every notification is one recipient on one channel, with a real delivery status.

| Channel | Provider | Available when | Statuses |
|---|---|---|---|
| `in_app` | App inbox (`/portal/notifications`) | Always | `sent` on creation; `readAt` when opened |
| `email` | Brevo transactional email API | `BREVO_API_KEY` set | `queued` → `sent` \| `failed` (`EMAIL_NOT_CONFIGURED` without Brevo) |
| `sms`, `whatsapp` | Twilio Messages API | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `TWILIO_SMS_FROM` / `TWILIO_WHATSAPP_FROM` | `queued` → `sent` → `delivered` (only after Twilio's receipt; needs `PUBLIC_API_URL`) \| `failed` |
| `push` | Firebase Cloud Messaging HTTP v1 | `FCM_SERVICE_ACCOUNT` (service-account JSON path or base64) | `queued` → `sent` \| `failed`. Created only for users with a registered device. |
| `none` | — | — | `failed` with `NO_GUARDIAN` / `NO_CONTACT_CHANNEL`: the person could not be reached |

- Queued messages are delivered in the background right after they are created, by a check every minute, and on server start.
- Each message is claimed before sending, so overlapping runs never send twice.
- Temporary provider errors (network, 5xx, 429) are retried after 1 and 5 minutes, three attempts in total. While waiting, the status is `queued` with `attempts > 0` (shown as "retrying").
- Rejected requests (invalid number, unknown token) fail at once. FCM tokens reported as unregistered are deleted.
- SMS, WhatsApp and push can be selected (alert channels, fee reminder channels, announcements) only when configured: otherwise `400 CHANNEL_NOT_CONFIGURED`.
- Phone numbers without a country code get `SMS_DEFAULT_COUNTRY_CODE` (default 91).

**Automatic alerts** (absent/late, exam results) go to every guardian who receives alerts, on the school's alert channels (default `in_app, email, push`). Fee reminders use their own channel list (`/fees/reminders/settings`, which now accepts all five channels).

### Message templates
Templates: `attendance.absent`, `attendance.late`, `fees.reminder.before`, `fees.reminder.due`, `fees.reminder.overdue`, `exam.results`.

Placeholders are written `{{name}}`. Each template allows only its own variables, for example `student, class, date, school` for attendance. Unknown placeholders are rejected with `UNKNOWN_PLACEHOLDER`. The same text goes to every channel; SMS and WhatsApp send the body.

### Announcements and notices
- `kind`: `announcement` (delivered once) or `notice` (also on the notice board until `expiresAt`, optionally `pinned`).
- `audience.scope`: `everyone` \| `staff` \| `families` \| `parents` \| `students`.
- `audience.classIds` / `sectionIds` narrow family scopes; either list matches. `campusId` narrows any scope.
- Campus-restricted staff must choose one of their campuses (`CAMPUS_REQUIRED`).
- Family audiences use active enrollments in the current session. Parents are guardians who receive alerts. Students are included when they can be reached (app login, email or phone).
- Each person receives an announcement once, even if they are both staff and a parent, or a parent of several children in the audience.
- The app inbox is always included.
- Status: `draft` → `scheduled` → `sending` → `sent`. A scheduled announcement can return to `draft`; drafts and scheduled ones can be `cancelled`.
- Scheduled announcements are sent within a minute of `scheduledAt`. If the server stops mid-send, sending resumes and skips anyone already notified.
- Permissions: `communication.create` writes drafts (teachers), `communication.send` sends, schedules and cancels.

| Method | Path | Notes |
|---|---|---|
| GET | `/communication/notices` | Notice board for the caller (any role with `communication.read`). Staff see `everyone`/`staff` notices on their campuses. Parents and students see `everyone`/`families`/their group, matching their (children's) campus, class or section. Pinned first. |
| GET | `/communication/announcements` | Staff. Query `status?, kind?, search?, page, limit`. Campus-restricted staff see their campuses only. |
| POST | `/communication/announcements` | `{ kind?, title, body (≤2000), audience{ scope, classIds?, sectionIds? }, campusId?, channels?, expiresAt?, pinned? }` → draft |
| GET | `/communication/announcements/:id` | Includes `stats{ recipients, notifications, unreachable }` and `delivery{ <channel>: { total, queued, sent, delivered, failed, read } }` |
| PATCH | `/communication/announcements/:id` | Drafts only; for sent notices only `pinned` and `expiresAt` (`ANNOUNCEMENT_NOT_EDITABLE`) |
| DELETE | `/communication/announcements/:id` | Drafts and cancelled only |
| POST | `/communication/announcements/:id/send` | `{ scheduledAt? }`: future time schedules, otherwise sends now (`ANNOUNCEMENT_NOT_DRAFT` if already sent) |
| POST | `/communication/announcements/:id/unschedule`, `/cancel` | |

### Notification history, channels and templates (staff)
| Method | Path | Notes |
|---|---|---|
| GET | `/communication/notifications` | `communication.send`. Query `type? (e.g. attendance.*), channel?, status? (incl. retrying), from?, to?, search? (recipient name), announcementId?, studentId?, page, limit`. `meta.byStatus` totals. Campus-restricted staff see notifications about their students and their campuses' announcements. |
| POST | `/communication/notifications/:id/retry` | `communication.send`. Failed email/SMS/WhatsApp/push only (`NOT_RETRYABLE`). Returns the notification after the new attempt. |
| GET | `/communication/channels` | `{ channels[{ channel, label, available, deliveryReceipts }], alertChannels, feeReminderChannels }` |
| PATCH | `/communication/channels` | `settings.update`. `{ alertChannels[] }` (in-app always added) |
| GET | `/communication/templates` | Each template with `variables`, current and default wording, `customized`, and a `preview` with sample values |
| PUT / DELETE | `/communication/templates/:key` | `settings.update`. PUT `{ title (≤200), body (≤1000) }`; DELETE resets to the default |

### Push devices — `/devices` 🔒 (user, not school)
| Method | Path | Notes |
|---|---|---|
| POST | `/devices` | `{ token, platform: android\|web }`. Registers the FCM token for the signed-in user. A token registered by another user moves to this one. Up to 10 devices per user. |
| DELETE | `/devices` | `{ token }`. Removes the caller's own token (on sign-out). |

### Twilio delivery receipts — `POST /webhooks/twilio/status` (public)
Twilio posts `MessageSid`, `MessageStatus` and `ErrorCode?` as form fields.

- **Authentication:** `X-Twilio-Signature`, computed over `PUBLIC_API_URL` + `/api/v1/webhooks/twilio/status`. An invalid signature returns `403 INVALID_SIGNATURE`.
- **`delivered` / `read`:** the notification becomes `delivered`.
- **`failed` / `undelivered`:** the notification becomes `failed`.
- **Ordering:** a status never moves backwards.

## Reports and analytics — `/reports` 🔒🏫 (plan module `reports`)
Staff with `reports.read` only: admin, principal and accountant by default. Each overview section and each export also needs the permission for its area, and uses the same access rules as that module's own pages, such as campus limits.

| Method | Path | Notes |
|---|---|---|
| GET | `/reports/overview` | `{ asOf, session, students?, staff?, attendance?, fees?, exams?, library?, hostel?, communication? }`. Sections and the permission each needs are listed below this table. |
| GET | `/reports/exports` | Catalogue `[{ key, label, description, available }]` |
| GET | `/reports/exports/:key` | CSV download (UTF-8 with BOM). The available reports are listed below this table. Unknown query fields → 422. More than 20,000 rows → `REPORT_TOO_LARGE`. Each export is audit-logged. |

**Overview sections**

| Section | Needs | Contents |
|---|---|---|
| `students` | `students.read` | Active count, by class, by gender |
| `staff` | `staff.read` | Active count, by role |
| `attendance` | `attendance.reports` | Daily % for the last 30 days, from submitted registers |
| `fees` | `fees.reports` | Receipts per month for 12 months; outstanding by class |
| `exams` | `exams.read` | Pass rate of the last 5 published exams |
| `library` | `library.read` | |
| `hostel` | `hostel.read` | Occupancy |
| `communication` | `communication.send` | Messages by channel and status, last 30 days |

**Exports**

| Key | Needs | Query |
|---|---|---|
| `students` | `students.read` | `classId?, sectionId?, status?, campusId?` |
| `staff` | `staff.read` | `role?, status?, campusId?` |
| `attendance` | `attendance.reports` | `from, to` (at most a year), `classId?, sectionId?` |
| `fee-payments` | `fees.reports` | `from, to, method?, source?` |
| `fee-defaulters` | `fees.reports` | `sessionId?, classId?, sectionId?` |
| `exam-results` | `exams.read` | `examId, sectionId` |

Values that start with `=`, `+`, `-` or `@` are prefixed with `'` so spreadsheets never run them as formulas.

## Platform (super admin) — `/platform` 🔒👑
Requires `User.platformRole = "super_admin"`. These routes never use a tenant context: school ids in the path are explicit administrative targets.

| Method | Path | Notes |
|---|---|---|
| GET | `/platform/modules` | `{ core[], plan[{ key, label }] }` |
| GET | `/platform/analytics` | Platform-wide figures, all counted from stored records. Fields are listed below this table. |
| GET | `/platform/plans` | Query `includeInactive` (default `true`) |
| POST | `/platform/plans` | `{ name, code, description?, currency, priceMonthly, priceYearly (smallest unit, e.g. paise), trialDays, modules[], limits{ maxStudents, maxCampuses, maxUsers }, isActive, sortOrder }` |
| GET / PATCH | `/platform/plans/:planId` | `code` is immutable. Partial `limits` are merged. Edits affect future assignments only. |
| DELETE | `/platform/plans/:planId` | `409 PLAN_IN_USE` if any school uses it (deactivate instead) |
| GET | `/platform/schools` | Query `page, limit, status, search`. Each row includes a `subscription` summary. |
| POST | `/platform/schools` | **Onboard**: `{ school{ name, code, type?, email?, phone?, address?, timezone?, currency? }, owner{ name, email, phone? }, campus?{ name='Main Campus', code='MAIN' }, planId, trial=true, billingCycle='monthly' }`. Creates the school, main campus, owner (new or existing user) and subscription. Uses a transaction when available, otherwise rolls back by hand on failure. |
| GET | `/platform/schools/:schoolId` | `{ school, subscription, subscriptionRecord, usage, owners[] }` |
| PATCH | `/platform/schools/:schoolId` | Profile fields + `code` |
| PATCH | `/platform/schools/:schoolId/status` | `{ status: active\|suspended\|cancelled, reason? }`. Suspension blocks all members immediately. |
| PUT | `/platform/schools/:schoolId/subscription` | Assign a plan: `{ planId, trial?, billingCycle (monthly\|yearly\|custom), currentPeriodEnd? (required for custom), graceDays?, modules? (override), limits? (override), notes? }` |
| PATCH | `/platform/schools/:schoolId/subscription` | Adjust without changing plan: `{ status?, currentPeriodEnd?, graceDays?, modules?, limits?, notes? }` |
| POST | `/platform/schools/:schoolId/owners` | Recovery: add an owner `{ name, email, phone? }` |
| GET | `/platform/audit-logs` | Query `page, limit, schoolId, action, actorId, platformOnly=true` |


**`GET /platform/analytics` fields**
- `schools`: `total`, `byStatus`, `byType`, `newThisMonth`.
- `subscriptions.byStatus`: subscription statuses of active schools, after expiry rules.
- `people`: `students` (active), `staff`, `parents` (guardian records), `parentLogins`, `studentLogins`, `users`, `activeUsers30d`.
- `revenue`: `monthlyRecurring` and `annualRunRate`, in paise. Computed from the agreed price of paid (`active`) subscriptions; yearly prices are divided by 12. This is not money received.
- `plans[]`: `schools`, `students` and `monthlyRevenue` per plan.
- `growth[]`: new schools per month for 12 months.
- `attention[]`: schools that need follow-up, such as a trial or renewal within 14 days, expired, past due, no plan, or at 90% of the student limit.
- `topSchools[]`: every school with its plan, subscription status, students, staff, parents and monthly revenue, largest first.

---

## System

### `GET /health`
`{ uptime, db: "up"|"down" }`. Returns 503 when the database is down.

## Roles and permissions

Built-in school roles: `school_owner`, `school_admin`, `principal`, `accountant`, `teacher`, `staff`, `parent`, `student`.
The permission catalogue (`<module>.<action>`) and role mappings are in `src/constants/permissions.js` and `src/constants/roles.js`. The module catalogue is in `src/constants/modules.js`.
