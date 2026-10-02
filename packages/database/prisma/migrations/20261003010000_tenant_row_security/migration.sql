BEGIN;

-- Transaction-local identity is set only after the API verifies its session.
ALTER TABLE "Organization" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Organization" FORCE ROW LEVEL SECURITY;
ALTER TABLE "OrganizationMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "OrganizationMember" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Workspace" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Workspace" FORCE ROW LEVEL SECURITY;
ALTER TABLE "WorkspaceMember" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "WorkspaceMember" FORCE ROW LEVEL SECURITY;

-- Membership policies deliberately avoid recursive organization lookups.
CREATE POLICY tenant_membership_read ON "OrganizationMember" FOR SELECT
  USING ("userId" = current_setting('app.user_id', true) AND status = 'ACTIVE');
CREATE POLICY tenant_workspace_membership_read ON "WorkspaceMember" FOR SELECT
  USING ("userId" = current_setting('app.user_id', true) AND status = 'ACTIVE'
    AND EXISTS (SELECT 1 FROM "OrganizationMember" m
      WHERE m."organizationId" = "WorkspaceMember"."organizationId"
        AND m."userId" = current_setting('app.user_id', true) AND m.status = 'ACTIVE'));
CREATE POLICY tenant_organization_read ON "Organization" FOR SELECT
  USING (status = 'ACTIVE' AND EXISTS (SELECT 1 FROM "OrganizationMember" m
    WHERE m."organizationId" = "Organization".id
      AND m."userId" = current_setting('app.user_id', true) AND m.status = 'ACTIVE'));
CREATE POLICY tenant_workspace_read ON "Workspace" FOR SELECT
  USING (status = 'ACTIVE'
    AND EXISTS (SELECT 1 FROM "Organization" o WHERE o.id = "Workspace"."organizationId" AND o.status = 'ACTIVE')
    AND EXISTS (SELECT 1 FROM "OrganizationMember" m
      WHERE m."organizationId" = "Workspace"."organizationId"
        AND m."userId" = current_setting('app.user_id', true) AND m.status = 'ACTIVE'
        AND (m.role IN ('OWNER', 'ADMIN') OR EXISTS (SELECT 1 FROM "WorkspaceMember" wm
          WHERE wm."organizationId" = "Workspace"."organizationId" AND wm."workspaceId" = "Workspace".id
            AND wm."userId" = current_setting('app.user_id', true) AND wm.status = 'ACTIVE'))));

-- No runtime write policy: provisioning belongs to a separate operator identity.
COMMIT;
