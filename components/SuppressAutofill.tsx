'use client';

import { useEffect } from 'react';

/**
 * Kills the browser's "save password?" / autofill prompts app-wide.
 *
 * This is an internal dev toolkit — none of its inputs are real credential fields,
 * yet Chrome/Edge heuristically flag plain text boxes (search keywords, env values,
 * connection names) and pops the save-password bar over them repeatedly. There is no
 * single `<form>` to annotate; inputs live across ~10 components and many render
 * lazily inside drawers/wizards.
 *
 * Rather than hand-annotate 70 inputs (and miss new ones), we stamp every
 * <input>/<textarea> with autocomplete="off" once on mount, and keep a
 * MutationObserver running so inputs mounted later (drawers, preset wizard,
 * dynamically-added rows) get the same treatment. Renders nothing.
 */
export default function SuppressAutofill() {
  useEffect(() => {
    const OFF = 'off';

    const stamp = (el: Element) => {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        // Skip real credential inputs if any are ever added — they should opt in
        // with autoComplete="new-password" themselves; don't clobber that.
        if (el.getAttribute('autocomplete') === 'new-password') return;
        if (el.getAttribute('autocomplete') !== OFF) el.setAttribute('autocomplete', OFF);
        // These defang Chromium's heuristic detector, which ignores
        // autocomplete="off" alone on password-looking fields.
        if (!el.hasAttribute('data-lpignore')) el.setAttribute('data-lpignore', 'true');
        if (!el.hasAttribute('data-form-type')) el.setAttribute('data-form-type', 'other');
        if (el.name && /pass|secret|token|pwd/i.test(el.name)) el.setAttribute('autocomplete', 'new-password');
      }
    };

    const sweep = (root: ParentNode) => {
      root.querySelectorAll('input, textarea').forEach(stamp);
    };

    sweep(document);

    const obs = new MutationObserver((records) => {
      for (const rec of records) {
        rec.addedNodes.forEach((node) => {
          if (node instanceof Element) {
            stamp(node);
            sweep(node);
          }
        });
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });

    return () => obs.disconnect();
  }, []);

  return null;
}
