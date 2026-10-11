# AGENTS.md

Instructions for coding agents working in this repository.

## Project

Rice吃啥 (Rice Eats) is a food guide and interactive restaurant map for the area around Rice University in Houston. It is an independent community project, not an official Rice University service.

Planned architecture: a static single-page site built with React, TypeScript, Vite, Tailwind CSS, and Leaflet, with restaurant content stored as Markdown and deployed to GitHub Pages. The initial version is in Chinese. The site is not implemented yet; do not assume any of this exists until it is added.

## Principles

- Prefer simple, maintainable, static-first solutions.
- Follow established project conventions (`.editorconfig`, `.gitattributes`, existing code style).
- Keep changes focused on the assigned task.
- Do not add dependencies or backend infrastructure without a concrete need.

## Content

- Preserve existing content and user-authored reviews.
- Never invent restaurant information, ratings, reviews, or photos.
- Do not silently overwrite or delete user-provided content; ask first.

## Licensing

Source code is MIT-licensed. Restaurant reviews, photographs, editorial content, and other contributed media are excluded from the MIT License. Keep code and editorial content licensing separate, and do not relicense content.
