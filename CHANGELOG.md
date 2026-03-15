# Changelog

All notable changes to the Force Cockpit extension will be documented in this file.

## [0.0.1] - 2026-03-15

### Added

- Overview tab: org info card, storage usage bars, SOQL query editor with results table
- Utils tab: Clone User and Reactivate OmniScript built-in utilities
- Utils tab: YAML-based custom scripts (Apex, Command, JavaScript) with configurable inputs
- Monitoring tab: SOQL-powered Chart.js dashboards from YAML configs (bar, line, pie, doughnut, metric, table)
- Private scripts and monitoring configs (git-ignored via `force-cockpit/private/`)
- Auto-connect to the default org from `.sf/config.json` with retry and token refresh
- Sensitive org confirmation banner for production and protected sandboxes
- Sub-category support for scripts and monitoring configs
