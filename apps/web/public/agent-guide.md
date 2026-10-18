# Overroot agent access

Guide: https://overroot.toni.foo/agent-guide.md

The API base is `https://overroot.toni.foo`. The project owner gives you an opaque project hash and a project-scoped agent password.

Check `GET /api/v1/status` before proceeding. Fetch `https://overroot.toni.foo/api/v1/openapi.json`, then authenticate every API request with:

```text
Authorization: Bearer <agent-password>
```

Bootstrap with `GET /api/v1/agent/context`; verify its project hash, then list files:

```bash
API='https://overroot.toni.foo'
PASSWORD='ul_agent_...'
curl -fsS "$API/api/v1/status"
curl -fsS -H "Authorization: Bearer $PASSWORD" "$API/api/v1/agent/context"
```

Before changing, renaming, or deleting a file, GET it and copy its `revision` into the mutation request:

```text
If-Match: <revision>
```

A `409 revision_conflict` means a person or another agent edited the file. Fetch it again, merge deliberately, and retry. Never retry by blindly overwriting. Creating a new path does not need `If-Match`.

Direct file edits and compilation results are broadcast immediately to connected collaborators. Use `POST /api/v1/projects/{projectHash}/compile`, then inspect `/compile/latest` or the job endpoint. The OpenAPI document is authoritative for request and response fields.
