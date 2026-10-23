# Changelog

All notable changes to this project will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.2.0] - 2026-10-23
### Fixed
- Dry runs and non-persisting forced replays no longer initialize missing checkpoints.
- Corrected the VPS runner's repository path and aligned its cron schedule with the documented 30-minute interval.
- Corrected Google Cloud Scheduler permissions for second-generation functions and tied rebuilds to source object generations.
- Corrected Azure Linux Consumption runtime and hosting settings, and replaced expiring deployment package tokens with managed identity access.
- Replaced randomly regenerated Azure and Google Cloud resource names with stable defaults.

### Changed
- Extracted shared application logic into a runtime-independent handler factory while retaining the Node entry point.
- Refreshed shared application and Azure/Google Cloud infrastructure dependencies, including security overrides.
- Updated deployment, maintenance, and existing-stack migration instructions.
- Documented Azure Linux Consumption's September 30, 2028 retirement date.

### Added
- Optional Cloudflare Workers deployment with Pulumi-managed KV state, secret bindings, and Cron Triggers.
- Workers behavior tests covering parser parity, embeds, checkpoints, retries, and multiple accounts.
- Local regression checks for cloud infrastructure settings, deployment wrappers, and shared dependencies.

## [1.1.0] - 2025-11-29
### Added
- Added support for posting from multiple Letterboxd accounts
- Added support for optional Discord usernames in posts

### Changed
- Updated Pulumi stacks for AWS/GCP/Azure to support the new features
- Rewrote all READMEs

## [1.0.1] - 2025-11-28
### Changed
- Aligned AWS/GCP/Azure runtimes on Node.js v22
- Updated Pulumi provider dependencies to the latest versions for all infra stacks

## [1.0.0] - 2025-10-28
- Initial release
