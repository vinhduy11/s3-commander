# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Status: Tauri 2 + React + TypeScript + Vite scaffold only (no git repo yet). The design below is the owner's intent; update the reference files as code lands. Project layout is in `docs/claude/structure.md`.

## Project

Desktop app (Tauri) to manage files and directories on a MinIO server via its S3-compatible API (custom endpoint per profile, not AWS S3), with a Total Commander-style dual-pane UI. Supports multiple profiles; profile secrets are encrypted with a keychain, and the app is unlocked with a master key.

## Architecture

**See [`docs/claude/architect.md`](docs/claude/architect.md)** — dual-pane UI, profiles, keychain and master-key design.

## Rules

**See [`docs/claude/rule.md`](docs/claude/rule.md)** — coding conventions (also see global `~/.claude/rule.md`).

## Safety

**See [`docs/claude/safety.md`](docs/claude/safety.md)** — secret handling, master key, and destructive S3 operations.

## Commands

**See [`docs/claude/commands.md`](docs/claude/commands.md)** — dev, build, test commands for the Tauri app, Rust and frontend.

## Deployment

**See [`docs/claude/deployment.md`](docs/claude/deployment.md)** — macOS DMG, signing and notarization, Linux build prerequisites and bundles, CI commands.
