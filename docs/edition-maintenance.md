# Community and Official Maintenance Boundary

Brevyn Community and Brevyn Official are maintained in separate repositories, use separate application IDs and data directories, and publish through independent release channels.

## Community Repository

The public Community repository is the source of truth for open-source, BYOK functionality, including the course workspace, local files, document previews, retrieval, citations, Agent workflows, Skills, MCP integration, and shared desktop infrastructure.

It must not contain Brevyn Official credentials, account and billing services, wallet or subscription logic, private deployment configuration, or proprietary hosted-provider integration.

## Official Repository

Brevyn Official may reuse accepted Community changes under the repository license and Contributor License Agreement. Official-only product and service code remains in the private repository.

## Synchronization Policy

There is currently no automatic synchronization between Community and Official.

- Community changes are reviewed and released independently.
- Relevant Community changes may be incorporated into Official manually after review.
- Shared fixes developed for Official should be reviewed for a clean Community contribution before any public transfer.
- Private repository branches, credentials, and commercial configuration must never be pushed or merged into Community.
- Community and Official version numbers do not need to match.

This manual boundary is intentional while the two editions and their release processes are still stabilizing.
