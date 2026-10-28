// SPDX-FileCopyrightText: Copyright Logically Magic Inc. <hello@logicallymagic.com>
// SPDX-FileCopyrightText: Copyright Hamid Jahanzad <Hamid@Jahanzad.com>
// SPDX-FileCopyrightText: Copyright Contributors to the Sentin8:E2E
// SPDX-License-Identifier: Apache-2.0

// fixtures/harness.ts - Playwright helpers for the Sentin8 e2e suites.
//
// This is the **platform-level** harness - it lives in sentin8/ and
// contains all platform-generic Flutter CanvasKit helpers (sign-in,
// org/env creation, sidebar navigation, feature toggles, branding).
// Vertical e2e suites (bank8, hotel8) import from here and add
// vertical-specific helpers on top.
//
// All Flutter interactions dispatch synthetic MouseEvents on
// flt-semantics nodes because Flutter CanvasKit FilledButtons don't
// respond to Playwright's native clicks.

import { type Page, type Browser, type BrowserContext, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { URLs, DOMAIN, type Persona, bff8AppURL, app8RuntimeURL } from './testdata.js';
import { E2EState, updateState, loadState } from './state.js';
import { logStep } from './log.js';

// ── Low-level Flutter helpers ─────────────────────────────────────────

/**
 * Find a flt-semantics element containing the given text and dispatch
 * a synthetic click.  This is the only way to trigger Flutter
 * CanvasKit button presses - Playwright's locator click is
 * intercepted by the canvas.
 */
export async function clickFlutterButton(page: Page, text: string, exact: boolean = false): Promise<void> {
  // Find the flt-semantics button element containing the text, get its
  // bounding rect, and click at its center using Playwright's mouse.
  // This sends real pointer events that Flutter CanvasKit processes.
  // Retry up to 10 seconds - the button might not be rendered yet, e.g.
  // the org home page may be in its transient-403 retry loop right after
  // org creation (identity invalidation settle window, §3.1d-1).
  // 20s window: right after org creation the caller's identity may be cached
  // pre-grant (§3.1d-1) - the bootstrap settle-retry needs the identity
  // invalidation to land (~5s provisioning + up to 5s bus fanout) before the
  // org home renders its Create Environment button.
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const rect = await page.evaluate(({ needle, exact }: { needle: string; exact: boolean }) => {
      const n = needle.toLowerCase();
      const els = document.querySelectorAll('flt-semantics');
      let buttonMatch: Element | null = null;
      let leafMatch: Element | null = null;
      for (const el of Array.from(els)) {
        const raw = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`;
        const t = raw.trim().toLowerCase();
        const matches = exact ? t === n : t.includes(n);
        if (!matches) continue;
        // Skip zero-size elements (stale/hidden)
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const hasChild = el.querySelector('flt-semantics') !== null;
        const role = el.getAttribute('role');
        if (role === 'button') {
          buttonMatch = el;
        } else if (!hasChild && role !== 'textbox') {
          leafMatch = el;
        }
      }
      const best = buttonMatch ?? leafMatch;
      if (!best) return null;
      const r = best.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, { needle: text, exact });
    if (rect) {
      await page.mouse.click(rect.x, rect.y);
      return;
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`No Flutter element found containing "${text}"`);
}

/**
 * Click a Flutter button (by label) that is near - i.e. inside the same
 * flt-semantics subtree as - another text label. Useful for clicking a
 * "View" button in a card that also contains the row's name.
 *
 * Strategy: find the flt-semantics container whose text includes `nearText`,
 * then search within that subtree for a button matching `buttonText`.
 * Fallback: if no container is found, click the first button matching
 * `buttonText` anywhere on the page.
 */
export async function clickFlutterButtonNearText(
  page: Page,
  buttonText: string,
  nearText: string,
  timeout = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const rect = await page.evaluate(({ btn, near }: { btn: string; near: string }) => {
      const btnLower = btn.toLowerCase();
      const nearLower = near.toLowerCase();
      const els = document.querySelectorAll('flt-semantics');
      // First, find the container element that includes the near text.
      let container: Element | null = null;
      for (const el of Array.from(els)) {
        const t = (el.textContent ?? '').toLowerCase();
        if (t.includes(nearLower)) {
          // Pick the smallest element that contains the text (leaf-ish).
          if (!container || (container.textContent ?? '').length > (el.textContent ?? '').length) {
            container = el;
          }
        }
      }
      // If no container found, search the entire page.
      const searchRoot = container ?? document.body;
      // Search within the container's subtree for the button.
      const candidates = searchRoot.querySelectorAll('flt-semantics');
      for (const el of Array.from(candidates)) {
        const raw = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`;
        const t = raw.trim().toLowerCase();
        if (!t.includes(btnLower)) continue;
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        const role = el.getAttribute('role');
        if (role === 'button' || role === 'link') {
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      return null;
    }, { btn: buttonText, near: nearText });
    if (rect) {
      await page.mouse.click(rect.x, rect.y);
      return;
    }
    await page.waitForTimeout(200);
  }
  // Fallback: try clicking the button anywhere on the page.
  try {
    await clickFlutterButton(page, buttonText);
  } catch {
    throw new Error(`No Flutter button "${buttonText}" near "${nearText}"`);
  }
}

/** Wait for flt-semantics to be present (Flutter booted). */
export async function waitForFlutterSemantics(page: Page, timeout = 2_000): Promise<void> {
  await page.waitForSelector('flt-semantics', { timeout });
}

/** Poll for a flt-semantics node or input element containing the given text. */
export async function waitForFlutterText(page: Page, text: string, timeout = 2_000): Promise<void> {
  const needle = text.toLowerCase();
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const found = await page.evaluate((n: string) => {
        const els = document.querySelectorAll('flt-semantics');
        // First pass: check non-zero-size elements (visible on screen)
        for (const el of Array.from(els)) {
          const t = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`.toLowerCase();
          if (!t.includes(n)) continue;
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width > 0 && r.height > 0) return true;
        }
        // Second pass: accept zero-size elements too. CanvasKit renders
        // text on the canvas, not in the DOM - the flt-semantics element
        // may have zero size but the text IS visible on the canvas.
        // Skip elements that are not connected to the DOM (stale/removed).
        for (const el of Array.from(els)) {
          const t = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`.toLowerCase();
          if (!t.includes(n)) continue;
          if (el.isConnected) return true;
        }
        // Check input/textarea elements (CanvasKit text fields)
        const inputs = document.querySelectorAll('input, textarea');
        for (const el of Array.from(inputs)) {
          const t = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('placeholder') ?? ''}`.toLowerCase();
          if (t.includes(n)) return true;
        }
        return false;
      }, needle);
      if (found) return;
    } catch {
      // Execution context destroyed (navigation in progress) - retry.
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`Timeout waiting for Flutter text "${text}"`);
}

/** Wait until page.url() contains the given substring. */
export async function waitForURLContains(page: Page, substr: string, timeout = 2_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (page.url().includes(substr)) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`Timeout waiting for URL to contain "${substr}" (current: ${page.url()})`);
}

/**
 * Click a Flutter checkbox/switch near a given text label.  Flutter
 * renders Checkbox/Switch and Text as separate semantics nodes inside
 * a Row, so we look for the toggle inside the same ancestor as the
 * label. Retries for up to 1 seconds.
 */
export async function clickFlutterCheckbox(page: Page, nearbyText: string): Promise<void> {
  const deadline = Date.now() + 1_000;

  // Map feature names to their switch index in the settings page.
  // The order matches the _envNavItems / _featureInfo order in Dash.
  // Platform feature names (sentin8): auth, app, storage, db, func, cron, flow, stat, bus, post
  const featureOrder = ['auth', 'app', 'storage', 'db', 'func', 'cron', 'flow', 'stat', 'bus', 'post'];
  const switchIndex = featureOrder.indexOf(nearbyText.toLowerCase());

  while (Date.now() < deadline) {
    // For feature toggles on the settings page, find the switch by index
    // (the switches are rendered in a fixed vertical order).
    // For other checkboxes (e.g. "Terms of Service"), use the text-matching
    // approach below.
    if (switchIndex >= 0) {
      const rect = await page.evaluate((idx: number) => {
        const els = document.querySelectorAll('flt-semantics');
        const switches = Array.from(els).filter(el => {
          const role = el.getAttribute('role');
          return role === 'switch' || role === 'checkbox';
        });
        if (idx >= switches.length) return null;
        const sw = switches[idx];
        // Get the parent Row's bounding rect (the feature card) - the InkWell
        // wraps the entire Row, so clicking the center of the Row triggers it.
        const row = sw.parentElement;
        if (row) {
          const r = (row as HTMLElement).getBoundingClientRect();
          if (r.width > 0 && r.height > 0) {
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
        // Fallback: use the switch's own rect.
        const r = (sw as HTMLElement).getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
        return null;
      }, switchIndex);
      if (rect) {
        // Disable pointer-events on ALL flt-semantics overlays so mouse
        // events go directly to the canvas underneath. Flutter CanvasKit
        // processes pointer events on the canvas element.
        await page.evaluate(() => {
          const container = document.querySelector('flt-semantics-host');
          if (container) {
            (container as HTMLElement).style.pointerEvents = 'none';
          }
          const els = document.querySelectorAll('flt-semantics');
          els.forEach(el => {
            (el as HTMLElement).style.pointerEvents = 'none';
          });
        });
        // Click at the card center - the GestureDetector with
        // HitTestBehavior.opaque should receive the pointer event.
        await page.mouse.click(rect.x, rect.y);
        await page.waitForTimeout(300);
        // Restore pointer events.
        await page.evaluate(() => {
          const container = document.querySelector('flt-semantics-host');
          if (container) {
            (container as HTMLElement).style.pointerEvents = '';
          }
          const els = document.querySelectorAll('flt-semantics');
          els.forEach(el => {
            (el as HTMLElement).style.pointerEvents = '';
          });
        });
        return;
      }
      await page.waitForTimeout(200);
      continue;
    }

    // For non-feature checkboxes (Terms of Service, etc.), use text matching.
    // First, scroll the target into view.
    const targetVisible = await page.evaluate((needle: string) => {
      const n = needle.toLowerCase();
      const els = document.querySelectorAll('flt-semantics');
      for (const el of Array.from(els)) {
        const t = (el.textContent ?? '').trim().toLowerCase();
        if (t === n || t.includes(n)) {
          const r = (el as HTMLElement).getBoundingClientRect();
          // Check if the element is within the viewport vertically.
          if (r.top >= 0 && r.bottom <= window.innerHeight) {
            return true;
          }
        }
      }
      return false;
    }, nearbyText);

    if (!targetVisible) {
      // Scroll down - try mouse wheel first, then keyboard Page Down.
      // Flutter CanvasKit processes wheel events on the canvas.
      await page.mouse.move(400, 300);
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(200);
      // Also try keyboard scroll (some Flutter scrollables respond to this).
      await page.keyboard.press('PageDown');
      await page.waitForTimeout(300);
      continue; // Re-check if the target is now visible.
    }

    const rect = await page.evaluate((needle: string) => {
      const n = needle.toLowerCase();
      const els = document.querySelectorAll('flt-semantics');
      // Find the text element whose text content or aria-label EXACTLY matches
      // the needle (case-insensitive). Try aria-label first (more specific),
      // then textContent. If no exact match, fall back to shortest partial.
      // If still no match, try matching by the text of child elements (Flutter
      // may nest the display name in a child flt-semantics inside a container).
      let textEl: Element | null = null;
      for (const el of Array.from(els)) {
        const t = (el.textContent ?? '').trim().toLowerCase();
        const a = (el.getAttribute('aria-label') ?? '').trim().toLowerCase();
        if (t === n || a === n) { textEl = el; break; }
      }
      if (!textEl) {
        // Try child elements - the display name might be in a child node.
        for (const el of Array.from(els)) {
          const child = el.querySelector('flt-semantics');
          if (child) {
            const ct = (child.textContent ?? '').trim().toLowerCase();
            if (ct === n) { textEl = child as Element; break; }
          }
        }
      }
      if (!textEl) {
        let bestLen = Infinity;
        for (const el of Array.from(els)) {
          const t = (el.textContent ?? '').trim().toLowerCase();
          const a = (el.getAttribute('aria-label') ?? '').trim().toLowerCase();
          if ((t.includes(n) || a.includes(n)) && t.length < bestLen) {
            bestLen = t.length;
            textEl = el;
          }
        }
      }
      if (!textEl) {
        // Fallback: no text match found. If there's only one checkbox/switch
        // on the page (e.g. Terms of Service on sign-up), click it.
        const allToggles = Array.from(els).filter(el => {
          const role = el.getAttribute('role');
          return role === 'checkbox' || role === 'switch';
        });
        if (allToggles.length === 1) {
          const rowEl = allToggles[0].parentElement;
          if (rowEl) {
            // Scroll the element into view before getting coordinates.
            (rowEl as HTMLElement).scrollIntoView({ block: 'center' });
            const rowRect = (rowEl as HTMLElement).getBoundingClientRect();
            if (rowRect.width > 0 && rowRect.height > 0) {
              return {
                x: rowRect.x + rowRect.width - 30,
                y: rowRect.y + rowRect.height / 2,
              };
            }
          }
        }
        return null;
      }
      // Scroll the text element into view so the switch is visible on the canvas.
      (textEl as HTMLElement).scrollIntoView({ block: 'center' });
      // Remove debug logging.
      // Find the switch/checkbox that is closest to the text element by
      // vertical position. In a feature card Row, the text and switch share
      // approximately the same y center, but the text might be at the top
      // of the card while the switch is centered. We find all switches
      // within 80px of the text's y center and pick the closest.
      const textRect = (textEl as HTMLElement).getBoundingClientRect();
      const textY = textRect.y + textRect.height / 2;
      const allSwitches = Array.from(els).filter(el => {
        const role = el.getAttribute('role');
        return role === 'checkbox' || role === 'switch';
      });
      if (allSwitches.length === 0) return null;
      // Find the switch closest to the text's y position.
      let bestSwitch: Element | null = null;
      let bestDist = Infinity;
      for (const sw of allSwitches) {
        const r = (sw as HTMLElement).getBoundingClientRect();
        const swY = r.y + r.height / 2;
        const dist = Math.abs(swY - textY);
        if (dist < bestDist) {
          bestDist = dist;
          bestSwitch = sw;
        }
      }
      if (!bestSwitch || bestDist > 80) return null;
      // Use the switch's own bounding rect (it has non-zero size in CanvasKit).
      const swRect = (bestSwitch as HTMLElement).getBoundingClientRect();
      if (swRect.width > 0 && swRect.height > 0) {
        return {
          x: swRect.x + swRect.width / 2,
          y: swRect.y + swRect.height / 2,
        };
      }
      // Fallback: use the text element's Row rect.
      const isCheckbox = bestSwitch.getAttribute('role') === 'checkbox';
      const rowRect = textRect;
      if (isCheckbox) {
        return { x: rowRect.x + 20, y: rowRect.y + rowRect.height / 2 };
      } else {
        return { x: rowRect.x + rowRect.width - 30, y: rowRect.y + rowRect.height / 2 };
      }
    }, nearbyText);
    if (rect) {
      // Try multiple approaches to toggle the switch:
      // 1. Simulate a proper tap gesture (move, down, wait, up) - Flutter
      //    CanvasKit requires a proper tap gesture, not just a click event.
      // 2. Dispatch a click event on the flt-semantics element
      // 3. Playwright's getByRole locator with force click
      await page.mouse.move(rect.x, rect.y);
      await page.mouse.down();
      await page.waitForTimeout(50);
      await page.mouse.up();
      await page.waitForTimeout(300);
      // Verify the switch toggled by checking aria-checked on the switch
      // closest to the text element's y position (same approach as the
      // coordinate computation above).
      const toggled = await page.evaluate((needle: string) => {
        const n = needle.toLowerCase();
        const els = document.querySelectorAll('flt-semantics');
        // Find the text element with exact match (same approach as above).
        let textEl: Element | null = null;
        for (const el of Array.from(els)) {
          const t = (el.textContent ?? '').trim().toLowerCase();
          if (t === n) { textEl = el; break; }
        }
        if (!textEl) {
          let bestLen = Infinity;
          for (const el of Array.from(els)) {
            const t = (el.textContent ?? '').trim().toLowerCase();
            if (t.includes(n) && t.length < bestLen) { bestLen = t.length; textEl = el; }
          }
        }
        if (!textEl) return false;
        const textRect = (textEl as HTMLElement).getBoundingClientRect();
        const textY = textRect.y + textRect.height / 2;
        // Find the switch closest to the text's y position.
        const allSwitches = Array.from(els).filter(el => {
          const role = el.getAttribute('role');
          return role === 'checkbox' || role === 'switch';
        });
        let bestSwitch: Element | null = null;
        let bestDist = Infinity;
        for (const sw of allSwitches) {
          const r = (sw as HTMLElement).getBoundingClientRect();
          const swY = r.y + r.height / 2;
          const dist = Math.abs(swY - textY);
          if (dist < bestDist) { bestDist = dist; bestSwitch = sw; }
        }
        if (!bestSwitch) return false;
        return bestSwitch.getAttribute('aria-checked') === 'true' ||
               bestSwitch.getAttribute('aria-pressed') === 'true';
      }, nearbyText).catch(() => false);
      if (toggled) return;
      // Not toggled by mouse click - try dispatching a click event on the
      // flt-semantics switch element directly. Use the same y-coordinate
      // matching to find the right switch.
      const dispatched = await page.evaluate((needle: string) => {
        const n = needle.toLowerCase();
        const els = document.querySelectorAll('flt-semantics');
        // Find the text element with exact match (same approach as above).
        let textEl: Element | null = null;
        for (const el of Array.from(els)) {
          const t = (el.textContent ?? '').trim().toLowerCase();
          if (t === n) { textEl = el; break; }
        }
        if (!textEl) {
          let bestLen = Infinity;
          for (const el of Array.from(els)) {
            const t = (el.textContent ?? '').trim().toLowerCase();
            if (t.includes(n) && t.length < bestLen) { bestLen = t.length; textEl = el; }
          }
        }
        if (!textEl) return false;
        const textRect = (textEl as HTMLElement).getBoundingClientRect();
        const textY = textRect.y + textRect.height / 2;
        // Find the switch closest to the text's y position.
        const allSwitches = Array.from(els).filter(el => {
          const role = el.getAttribute('role');
          return role === 'checkbox' || role === 'switch';
        });
        let bestSwitch: Element | null = null;
        let bestDist = Infinity;
        for (const sw of allSwitches) {
          const r = (sw as HTMLElement).getBoundingClientRect();
          const swY = r.y + r.height / 2;
          const dist = Math.abs(swY - textY);
          if (dist < bestDist) { bestDist = dist; bestSwitch = sw; }
        }
        if (!bestSwitch) return false;
        // Dispatch a click event on the switch element.
        (bestSwitch as HTMLElement).click();
        return true;
      }, nearbyText).catch(() => false);
      if (dispatched) {
        await page.waitForTimeout(300);
        return;
      }
      // Last resort: Playwright locator with force.
      try {
        const switchLocator = page.getByRole('switch', { name: nearbyText, exact: false });
        if (await switchLocator.count() > 0) {
          await switchLocator.first().click({ force: true });
          await page.waitForTimeout(300);
          return;
        }
      } catch { /* give up */ }
      return;
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`No checkbox found near "${nearbyText}"`);
}

/** Type into a Flutter text field identified by its label. */
export async function typeFlutterField(page: Page, label: string, value: string): Promise<void> {
  // Flutter web text fields can be found via:
  // 1. Regular <input>/<textarea> elements with aria-label (CanvasKit)
  // 2. Playwright's getByRole('textbox') using the accessibility tree
  //    (works even when flt-semantics[role=textbox] is not in the DOM)
  // 3. flt-semantics[role="textbox"] with aria-label (when semantics are in DOM)
  //
  // IMPORTANT: Flutter CanvasKit text fields use a custom editing host that
  // listens to real keyboard events. We focus the host, then send the
  // whole value in one shot via `page.keyboard.insertText` (a single
  // `input` event - paste-like).  We MUST NOT use character-by-character
  // `keyboard.type(...)` because (a) it's slow and (b) the per-character
  // `input` events can race with Flutter's text-editing controller.
  //
  // IMPORTANT: Flutter CanvasKit may lazy-build semantics nodes. The textbox
  // may not be in the accessibility tree immediately after page navigation.
  // We retry all approaches with short waits. We use a locator-based wait
  // first (up to 5s) so we don't waste time polling when the element hasn't
  // appeared yet, then fall through to the manual approaches.

  // Wait for the textbox to appear in the accessibility tree (up to 5s).
  // This replaces a fixed 2s deadline with an element-driven wait.
  // Try multiple locator strategies since Flutter CanvasKit may expose
  // textboxes differently depending on rendering timing.
  try {
    await page.getByRole('textbox', { name: label, exact: false })
      .first()
      .waitFor({ state: 'visible', timeout: 5_000 });
  } catch {
    // The accessibility tree may not expose the textbox via getByRole yet.
    // Try waiting for a flt-semantics element with the matching aria-label.
    try {
      await page.locator(`flt-semantics[aria-label="${label}"]`)
        .first()
        .waitFor({ state: 'attached', timeout: 3_000 });
    } catch {
      // Try waiting for any flt-semantics textbox to appear (the label
      // may be in textContent rather than aria-label).
      try {
        await page.locator('flt-semantics[role="textbox"]')
          .first()
          .waitFor({ state: 'attached', timeout: 3_000 });
      } catch {
        // Fall through to the manual polling approaches below.
      }
    }
  }

  // Extend the poll deadline after the element-driven waits so the
  // manual approaches still have time to find and focus the field.
  const deadline = Date.now() + 5_000;
  let lastError: Error | null = null;

  // Helper: focus a target, clear any existing value via Ctrl+A + Delete
  // (real keyboard events, picked up by Flutter), then insert the value
  // in one shot via `insertText` (a single `input` event - paste-like).
  const fillFocused = async (): Promise<void> => {
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.keyboard.insertText(value);
  };

  while (Date.now() < deadline) {
    lastError = null;

    // Approach 1: Try regular input/textarea elements.
    const inputs = page.locator('input, textarea');
    const count = await inputs.count();
    for (let i = 0; i < count; i++) {
      const aria = await inputs.nth(i).getAttribute('aria-label');
      if (aria && aria.toLowerCase() === label.toLowerCase()) {
        await inputs.nth(i).click();
        await page.waitForTimeout(50);
        await fillFocused();
        return;
      }
    }

    // Approach 2: Use Playwright's getByRole (accessibility tree) to find
    // the textbox and click it with force (bypasses actionability checks
    // since flt-semantics elements have zero size). This triggers Flutter's
    // text editing host to create a real <input> element on the canvas.
    try {
      const textbox = page.getByRole('textbox', { name: label, exact: false });
      if (await textbox.count() > 0) {
        await textbox.first().click({ force: true });
        await page.waitForTimeout(200); // Wait for Flutter to create the <input>
        await fillFocused();
        return;
      }
    } catch (e) {
      lastError = e as Error;
    }

    // Approach 3: Fall back to flt-semantics elements.
    const found = await page.evaluate((n: string) => {
      const els = document.querySelectorAll(
        'flt-semantics[role="textbox"], flt-semantics[contenteditable="true"]',
      );
      for (const el of Array.from(els)) {
        const t = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`.toLowerCase();
        if (t.includes(n)) {
          (el as HTMLElement).focus();
          return true;
        }
      }
      return false;
    }, label.toLowerCase());
    if (found) {
      await fillFocused();
      return;
    }

    // None of the approaches found the textbox yet - wait briefly and retry.
    await page.waitForTimeout(500);
  }

  throw new Error(`No Flutter text field found with label "${label}"${lastError ? ` (last error: ${lastError.message})` : ''}`);
}

/**
 * Focus a Flutter text field at the given 0-based index in DOM order
 * and type `value` into it.  Used by the create-listing helpers to
 * target the bare-hint fields inside [ScopeSelector] / [RoleSelector]
 * which have no `labelText` to match against.
 *
 * Indexing: Playwright's `getByRole('textbox')` walks the
 * accessibility tree in DOM order, so the index corresponds to the
 * order the user would tab through the visible fields.
 *
 * The textbox is clicked with `force: true` because `flt-semantics`
 * elements have zero size and Playwright's actionability checks
 * would otherwise fail.  After focus, Flutter creates a real
 * `<input>` element that receives the keyboard events.
 *
 * @param submit  If true, press Enter after typing.  The create
 *   form's scope/description inputs are committed on submit.
 */
export async function typeFlutterFieldByIndex(
  page: Page,
  index: number,
  value: string,
  options: { submit?: boolean } = {},
): Promise<void> {
  const { submit = false } = options;
  const deadline = Date.now() + 2_000;
  let lastError: Error | null = null;
  while (Date.now() < deadline) {
    lastError = null;
    try {
      // Wait for the textbox at the given index to exist.
      const textbox = page.getByRole('textbox').nth(index);
      if ((await textbox.count()) > 0) {
        await textbox.click({ force: true });
        await page.waitForTimeout(150);
        // Clear and type the new value using the same paste-like
        // pattern as [typeFlutterField].
        await page.keyboard.press('Control+A');
        await page.keyboard.press('Delete');
        await page.keyboard.insertText(value);
        if (submit) {
          await page.keyboard.press('Enter');
        }
        return;
      }
    } catch (e) {
      lastError = e as Error;
    }
    await page.waitForTimeout(200);
  }
  throw new Error(
    `No Flutter text field at index ${index} found${lastError ? ` (last error: ${lastError.message})` : ''}`,
  );
}

/**
 * Add a single scope to a [ScopeSelector] in the create-listing form.
 * The scope input is the next textbox after the form's known prefix
 * fields (App Name, Description, Backend URL) at `baseIndex` +
 * any prefix offset.
 *
 *   - For the outer OAuth Scopes selector: `baseIndex = 3`
 *     (textboxes 0..2 are App Name, Description, Backend URL).
 *   - For the inner ScopeSelector of role `k`: the scope textbox
 *     is at `baseIndex + 2` where `baseIndex` is the index of the
 *     role's name field.  The first role has 3 textboxes
 *     (name, description, scope); every subsequent role has 4
 *     (name, description, scope, includes).  See
 *     [createListingViaUI] for the baseIndex formula.
 *
 * Each call:
 *   1. Clicks the scope input (clearing any leftover text).
 *   2. Types the scope via `insertText` (paste-like, single input event).
 *   3. Presses Enter to commit the scope via the field's `onSubmitted`
 *      handler, which calls `_add()` on the ScopeSelector state.
 *
 * This exercises the real widget code path - the e2e test no longer
 * relies on a textual TextField that was removed in favour of the
 * structured chip-based selector.
 */
export async function addScopeViaUI(
  page: Page,
  scope: string,
  baseIndex: number,
): Promise<void> {
  // The scope input may be off-screen if the form has scrolled due
  // to many chips being added above. Scroll it into view first so
  // the subsequent click and keyboard events land on the visible
  // input - Flutter CanvasKit text fields require the input host
  // to be in the viewport to receive focus.
  await scrollFlutterTextboxIntoView(page, baseIndex);
  await typeFlutterFieldByIndex(page, baseIndex, scope, { submit: true });
  // Small wait for the chip to render + onChanged to fire.
  await page.waitForTimeout(100);
}

/**
 * Add multiple scopes in a single submit by typing them as a
 * comma-separated list.  The widget's `onSubmitted` handler splits
 * on `,` and whitespace, validates each token, and adds the
 * valid ones in one pass.  The duplicate check inside the widget
 * means already-added scopes are silently dropped - callers can
 * safely re-submit the full list.
 *
 * @param page  Playwright page.
 * @param scopes  Scope names (or a single space/comma-separated
 *   string) to add.  Empty entries are dropped.
 * @param baseIndex  Index of the scope input textbox in the global
 *   textbox ordering.
 */
export async function addScopesBatchViaUI(
  page: Page,
  scopes: string[],
  baseIndex: number,
): Promise<void> {
  if (!scopes || scopes.length === 0) return;
  // The scope input may be off-screen if the form has scrolled due
  // to many chips being added above. Scroll it into view first.
  await scrollFlutterTextboxIntoView(page, baseIndex);
  // Join with comma + space so the user could have typed the same
  // thing in the UI; whitespace and commas are both delimiters.
  const value = scopes.join(', ');
  await typeFlutterFieldByIndex(page, baseIndex, value, { submit: true });
  // Small wait for all chips to render + onChanged to fire once
  // per added scope.
  await page.waitForTimeout(200);
}

/**
 * Add a single include to a role's includes-picker via the
 * autocomplete text input.  The widget renders a `RawAutocomplete`
 * textbox; the user types the included role name and presses
 * Enter to commit.  Selected names then appear as removable
 * `InputChip`s below the input.
 *
 * The autocomplete enforces that the typed name matches an
 * existing candidate (defined above this row in the listing) -
 * otherwise the typed value is silently ignored.  This is by
 * design: dangling includes are impossible by construction.
 *
 * @param page  Playwright page.
 * @param name  Role name to include.  Must match a role defined
 *   earlier in the same listing.
 * @param baseIndex  Index of the includes-picker textbox in the
 *   global textbox ordering.  The first role has no includes
 *   textbox rendered (no candidates yet) - callers should only
 *   pass `baseIndex >= 11` (i.e. the third role onward; the
 *   second role already has one at index 10).
 */
export async function addIncludeViaUI(
  page: Page,
  names: string | string[],
  baseIndex: number,
): Promise<void> {
  // Scroll the includes textbox into view first - the includes
  // section sits at the bottom of the role, often off-screen.
  await scrollFlutterTextboxIntoView(page, baseIndex);
  // Accept a single name or an array.  Multiple names are typed
  // as a comma-separated list and committed in a single Enter,
  // which exercises the widget's batch-add path.  Each token is
  // resolved against the candidate list (case-sensitive) and
  // added if it matches and isn't already selected.
  const list = Array.isArray(names) ? names : [names];
  const value = list.join(', ');
  await typeFlutterFieldByIndex(page, baseIndex, value, { submit: true });
  // Wait for the chips to render + onChanged to fire.
  await page.waitForTimeout(250);
  // Verify the chips were actually added - guards against silent
  // drops if the typed names didn't match candidates.  Selected
  // includes are rendered as Material `InputChip`s, which Flutter
  // exposes as a `role="checkbox"` (with the chip label as the
  // accessible name) wrapping a Delete `button`.  We check each
  // name individually so callers can detect a partial success.
  for (const name of list) {
    const chip = page.getByRole('checkbox', { name, exact: true });
    if ((await chip.count()) === 0) {
      throw new Error(
        `addIncludeViaUI: include "${name}" was not committed - the autocomplete may have ` +
          `rejected it (typo? or this role is not defined above the current row?).`,
      );
    }
  }
}

/**
 * Add a security role to the create-listing form's [RoleSelector].
 * Clicks the "Add Role" button, then fills the role's name
 * (appending `*` if it's the default signup role), description,
 * and nested scopes - all via the actual UI controls.
 *
 * @param baseIndex  Index of the FIRST textbox for the new role.
 *   The form has 4 prefix textboxes (App Name, Description,
 *   Backend URL, OAuth Scopes) + 3 textboxes for the first role
 *   (no includes picker).  Each subsequent role adds 4 textboxes
 *   (name, description, scopes, includes).  So:
 *     - k=0:  baseIndex = 4
 *     - k=1:  baseIndex = 7
 *     - k=2:  baseIndex = 11
 *     - k=3:  baseIndex = 15
 *   See [createListingViaUI] for the formula.
 * @param isDefaultSignup  If true, append `*` to the name so the
 *   RoleSelector marks the role as default_signup_role.
 */
export async function addRoleViaUI(
  page: Page,
  role: {
    name: string;
    description?: string;
    scopes: string[];
    /**
     * Names of OTHER roles (defined earlier in the same listing)
     * whose scopes should be merged into this role's permissions
     * at install time.  Same listing only - the RoleSelector UI
     * only offers roles defined above the current row.
     */
    includes?: string[];
  },
  baseIndex: number,
  isDefaultSignup: boolean,
): Promise<void> {
  // The "Add Role" button is at the bottom of the [RoleSelector].
  // After a previous role has been filled in (with chips wrapping
  // below its scope input), the form may have scrolled down so the
  // button is just below the fold.  Flutter CanvasKit's click
  // handlers only fire when the InkWell is in the viewport, so we
  // scroll the button into view first.
  await scrollFlutterButtonIntoView(page, 'Add Role');
  // Click the "Add Role" button to create a new row.
  await clickFlutterButton(page, 'Add Role');
  // Wait for the new row's textboxes to appear.
  await page.waitForTimeout(300);
  // The new role's name field is at the top of its row; the form
  // has just grown, so scroll the new textbox into view before
  // typing.  Without this, the input may be off-screen and Flutter
  // may not focus it correctly.
  await scrollFlutterTextboxIntoView(page, baseIndex);
  // Fill the role name (textbox at baseIndex). Append `*` if this
  // is the default signup role - the RoleSelector strips the
  // marker and sets the default-signup pointer.
  const nameValue = isDefaultSignup ? `${role.name}*` : role.name;
  await typeFlutterFieldByIndex(page, baseIndex, nameValue);
  await page.waitForTimeout(100);
  // Fill the description if provided (textbox at baseIndex + 1).
  if (role.description) {
    await scrollFlutterTextboxIntoView(page, baseIndex + 1);
    await typeFlutterFieldByIndex(page, baseIndex + 1, role.description);
    await page.waitForTimeout(100);
  }
  // Fill the nested scope input (textbox at baseIndex + 2) by
  // typing the entire list of scopes as a comma-separated string
  // and submitting once.  The widget's `onSubmitted` splits on
  // `,`/whitespace and adds all valid scopes in a single pass,
  // which exercises the batch-add path the same way the user
  // would experience it.
  const scopeIndex = baseIndex + 2;
  await addScopesBatchViaUI(page, role.scopes ?? [], scopeIndex);
  // Add the `includes` autocomplete selections.  The widget renders
  // a text input where the user types the name of an existing role
  // (defined above this row in the listing) and presses Enter to
  // add it.  Selected roles are then shown as removable chips.
  // The first role (k=0) sees no candidates because no roles are
  // defined above it yet, so the autocomplete is not rendered for
  // that row.
  if (role.includes && role.includes.length > 0) {
    // The includes textbox sits at baseIndex + 3 (name, desc,
    // scopes, includes).  The first role (baseIndex=4) has no
    // includes textbox rendered (no candidates yet) - reject this
    // so the caller knows.
    if (baseIndex === 4) {
      throw new Error(
        `addRoleViaUI: includes on the first role ("${role.name}") are not supported - ` +
          `the autocomplete has no candidates until at least one role is defined above.`,
      );
    }
    // Pass the whole list at once so the widget's batch-add
    // path is exercised (one Enter submits everything).  The
    // helper verifies each chip was committed.
    await addIncludeViaUI(page, role.includes, baseIndex + 3);
  }
}

/**
 * Scroll the Flutter button containing the given text into the
 * viewport.  Flutter CanvasKit InkWells must be in the viewport to
 * fire their onPressed - a click at off-screen coordinates is
 * silently dropped.
 *
 * Strategy: find the button's flt-semantics rect, then scroll the
 * enclosing scrollable (window) until the button is visible.
 * Retries for up to 5 seconds.
 */
export async function scrollFlutterButtonIntoView(
  page: Page,
  text: string,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const visible = await page.evaluate(({ needle }: { needle: string }) => {
      const n = needle.toLowerCase();
      const els = document.querySelectorAll('flt-semantics');
      for (const el of Array.from(els)) {
        const raw = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`;
        if (!raw.toLowerCase().includes(n)) continue;
        if (el.getAttribute('role') !== 'button') continue;
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        // Visible if any part of the rect is within the viewport.
        const inView = r.bottom > 0 && r.top < window.innerHeight &&
                       r.right > 0 && r.left < window.innerWidth;
        if (inView) return true;
      }
      return false;
    }, { needle: text });
    if (visible) return;
    // Scroll down using wheel + keyboard. Flutter CanvasKit
    // scrollables respond to wheel events on the canvas.
    await page.mouse.move(400, 300);
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(200);
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(300);
  }
  // Don't throw - clickFlutterButton will throw a clear error if
  // the button still can't be found after scrolling.
}

/**
 * Scroll the textbox at the given 0-based index into the viewport.
 * Same viewport requirement as [scrollFlutterButtonIntoView].
 */
export async function scrollFlutterTextboxIntoView(
  page: Page,
  index: number,
): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const visible = await page.evaluate((idx: number) => {
      const textboxes = document.querySelectorAll(
        'flt-semantics[role="textbox"], input, textarea',
      );
      if (idx >= textboxes.length) return false;
      const el = textboxes[idx] as HTMLElement;
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return true; // can't tell
      const inView = r.bottom > 0 && r.top < window.innerHeight &&
                     r.right > 0 && r.left < window.innerWidth;
      return inView;
    }, index);
    if (visible) return;
    await page.mouse.move(400, 300);
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(200);
    await page.keyboard.press('PageDown');
    await page.waitForTimeout(300);
  }
}

/** Wait for a window test bridge function to be registered. */
export async function waitForBridge(page: Page, fn: string, timeout = 2_000): Promise<void> {
  await page.waitForFunction(
    (name: string) => typeof (window as unknown as Record<string, unknown>)[name] === 'function',
    fn,
    { timeout },
  );
}

/** Invoke a window test bridge function with string args. */
export async function callBridge(page: Page, fn: string, ...args: string[]): Promise<boolean> {
  const ok = await page.evaluate(
    ({ fn: name, args: a }: { fn: string; args: string[] }) => {
      const w = window as unknown as Record<string, (...args: unknown[]) => boolean>;
      if (typeof w[name] === 'function') return w[name](...a);
      return false;
    },
    { fn, args },
  );
  return Boolean(ok);
}

/** Return all flt-semantics text content (concatenated). */
export async function getFlutterTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const els = document.querySelectorAll('flt-semantics');
    // CanvasKit renders RFW pages as accessible NAMES (aria-label) -
    // e.g. the app store's listing cards are labeled groups with NO DOM
    // text content - so the harvest must include the label, mirroring
    // waitForFlutterText's two-pass strategy below.
    return Array.from(els).flatMap((el) => {
      const a = el as HTMLElement;
      const label = a.getAttribute('aria-label') ?? '';
      const text = (el.textContent ?? '').trim();
      return [text, label.trim()].filter((t) => t.length > 0);
    });
  });
}

/** Wait for Flutter content to appear on the page (retries until texts are found). */
export async function waitForFlutterContent(page: Page, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  let clickedRetry = false;
  while (Date.now() < deadline) {
    const texts = await getFlutterTexts(page);
    if (texts.length > 0) {
      // Check for RFW error states - the page may have rendered text
      // but it's just "Failed to load admin UI" or "No content".
      // Wait a bit more in case the real content is still loading.
      const allText = texts.join(' ');
      if (!allText.includes('Failed to load') && !allText.includes('No content')) {
        return;
      }
      // Transient identity-propagation 403 (policy design §3.1d-1): a
      // freshly created env can 403 its first admin-UI loads for ~1-2s
      // until the invalidation event propagates. The RFW page's own
      // Retry button is the user-level recovery - click it once (a real
      // user would); keep waiting for the content to settle.
      if (!clickedRetry && allText.includes('forbidden by policy')) {
        clickedRetry = true;
        try {
          await clickFlutterButton(page, 'Retry');
        } catch {
          // Retry button may already be gone (content landed) - fine.
        }
      }
    }
    await page.waitForTimeout(100);
  }
  // No content rendered (or only error content) - fail fast with a
  // descriptive error instead of letting the caller's expect() produce
  // a generic "0 > 0" message.
  const url = page.url();
  const texts = await getFlutterTexts(page);
  const snippet = texts.slice(0, 3).join(' | ');
  throw new Error(
    `waitForFlutterContent: no Flutter content rendered within ${timeout}ms at ${url}` +
    (snippet ? ` (texts: ${snippet})` : ''),
  );
}

// ── Browser / harness lifecycle ───────────────────────────────────────

export interface Harness {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  /** Internal - closes the browser and context. */
  _close(): Promise<void>;
}

/**
 * Launch a fresh Chromium browser with a single shared context.
 * Self-signed CA errors are ignored (HTTPS succeeds with the
 * ignoreHTTPSErrors option).
 */
export async function newHarness(): Promise<Harness> {
  // We use playwright's own launch - the test runner provides a
  // browser via the project config.  This helper is for ad-hoc use
  // (e.g. tests that want their own browser outside the runner).
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({
    // Headed by default (visible browser) - PLAYWRIGHT_HEADLESS=true for CI.
    headless: (process.env.PLAYWRIGHT_HEADLESS ?? 'false') === 'true',
    args: [
      '--window-size=1280,800',
      '--force-dark-mode',
      '--enable-features=WebContentsForceDark',
    ],
  });
  const context = await browser.newContext({
    baseURL: URLs.dash,
    ignoreHTTPSErrors: true,
    bypassCSP: true,
  });
  const page = await context.newPage();
  return {
    browser,
    context,
    page,
    _close: async () => {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    },
  };
}

// ── Sign-in / sign-up flows ───────────────────────────────────────────

/**
 * Clear the auth rate-limit Redis keys so that repeated sign-ins during
 * e2e tests don't trigger "Too many attempts" (bot protection default:
 * 10/min per IP, 5/min per email).
 */
export function clearAuthRateLimits(email: string): void {
  // The auth server uses Valkey DB 1 (SENTIN8_AUTH_VALKEY_URL=valkeys://localhost:6379/1).
  // Clear ALL rate-limit keys to ensure repeated sign-ins during e2e tests
  // don't trigger "Too many attempts" (bot protection default: 10/min per IP,
  // 5/min per email).
  const dbFlag = '-n 1';
  // First, try direct DEL of known keys (fast, no pipeline).
  try {
    const keys = [
      'auth:rate:ip:172.18.0.1',
      'auth:rate:ip:127.0.0.1',
      'auth:rate:ip:unknown',
      `auth:rate:email:${email.toLowerCase()}`,
    ];
    execSync(`valkey-cli ${dbFlag} DEL ${keys.map(k => `'${k}'`).join(' ')}`, { stdio: 'pipe', timeout: 2_000 });
  } catch {
    // Best-effort.
  }
  // Then clear ALL rate-limit keys via SCAN (covers any email/IP variations
  // - the auth server may store a slightly different email key than expected
  // due to form encoding, and the IP may vary).
  try {
    execSync(`valkey-cli ${dbFlag} --scan --pattern 'auth:rate:*' | xargs -r valkey-cli ${dbFlag} del`, { stdio: 'pipe', timeout: 2_000 });
  } catch {
    // Best-effort.
  }
}

/**
 * Detect the already-authenticated Dash state. When a valid session
 * exists (config-level storageState from global setup, or a prior
 * sign-in in this context), Dash renders an authenticated page
 * (org dashboard / organization picker) and the "Sign in" button
 * never appears - the sign-in flow below would time out waiting for it.
 *
 * Markers mirror the Flutter sources:
 *   - sign-in page  (apps/dash/lib/pages/sign_in_page.dart):
 *       "Sign in with Auth" / "Sign up" / "Browse as guest"
 *   - org picker    (apps/dash/lib/pages/organization_picker_page.dart):
 *       "Your Organizations" / "Create Organization"
 *   - org dashboard (org home): "Environments" / "Create Environment"
 */
export async function isDashSignedIn(page: Page, timeout = 2_000): Promise<boolean> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const state = await page.evaluate(() => {
        const texts: string[] = [];
        for (const el of Array.from(document.querySelectorAll('flt-semantics'))) {
          if (!el.isConnected) continue;
          texts.push(`${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`);
        }
        for (const el of Array.from(document.querySelectorAll('input, textarea'))) {
          texts.push(`${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('placeholder') ?? ''}`);
        }
        const joined = texts.join(' ').toLowerCase();
        const signedIn = ['your organizations', 'create organization', 'environments', 'create environment'];
        const signedOut = ['sign in with auth', 'sign up', 'browse as guest'];
        if (signedIn.some((m) => joined.includes(m))) return 'in';
        if (signedOut.some((m) => joined.includes(m))) return 'out';
        return 'unknown';
      });
      if (state === 'in') return true;
      if (state === 'out') return false;
    } catch {
      // Execution context destroyed (navigation in progress) - retry.
    }
    await page.waitForTimeout(100);
  }
  return false;
}

/**
 * Sign in to Dash from the /sign-in page.  Clears cookies, navigates
 * to Dash, clicks "Sign in" (which redirects to Auth8), fills the
 * form by typing into the real text fields, clicks the "Continue"
 * button, and waits for the redirect back to Dash.
 *
 * If Dash is already authenticated (valid session in the storage
 * state), returns immediately without touching the sign-in flow.
 */
export async function signInToDash(page: Page, context: BrowserContext, email: string, password: string): Promise<void> {
  clearAuthRateLimits(email);
  // Do NOT clear cookies - Playwright's clearCookies() wipes ALL domains,
  // which would destroy unrelated tenant BFF8 sessions. Each app's session
  // cookie is scoped to its own domain (e.g. bff8.dash.ops.sys.local.sentin8.dev)
  // so they don't conflict. The BFF8 OAuth flow handles session refresh.
  await page.goto(URLs.dash, { waitUntil: 'domcontentloaded' });
  if (await isDashSignedIn(page)) {
    logStep(`[step] signInToDash: already signed in - skipping sign-in flow for ${email}`);
    return;
  }
  logStep(`[step] signInToDash: signing in ${email}`);
  await waitForFlutterText(page, 'Sign in', 2_000);
  await clickFlutterButton(page, 'Sign in');
  // The authorize step routes by client consent mode (auth DESIGN §9a.8):
  // consent-gated clients land on the Flutter `/sign-in` SPA; consent-bypass
  // first-party clients (e.g. dash) land on the server-rendered HTML login
  // form at `/oauth/login` (the OIDF-suite-drivable surface). Poll for
  // whichever surface actually renders - the redirect chain (BFF /auth/login →
  // /oauth/authorize → terminal page) must settle first.
  const htmlFormDeadline = Date.now() + 10_000;
  let isHtmlForm = false;
  while (Date.now() < htmlFormDeadline) {
    if ((await page.locator('#username').count()) > 0) {
      isHtmlForm = true;
      break;
    }
    // SSO-COOKIE race (dsh-...-zcty26 class): after a signup the browser
    // holds a fresh auth session - clicking "Sign in" rides
    // authorize → callback → dash home WITHOUT ever rendering an auth
    // form. The `flt-semantics` count is 1+ on DASH ITSELF (the SPA was
    // never navigated away) and on auth's SPA alike, so counting semantics
    // cannot discriminate. Only the AUTH page has fields (HTML #username or
    // a *textbox* semantic node); a dash-side semantics node (no textbox,
    // no #username) means navigation has not left dash yet - keep waiting.
    if ((await page.locator('#username, input[aria-label="Email"], input[aria-label="Password"], flt-semantics[role="textbox"]').count()) > 0) {
      break;
    }
    await page.waitForTimeout(200);
  }
  // SSO-COOKIE auto-login (see the race note above): with a fresh auth
  // session the full chain (authorize → callback → dash) completes without
  // ever rendering an auth form - the deadline expired with the browser
  // back on dash. Treat that as signed-in (the caller's storage state now
  // carries the session) instead of hunting a field that will never exist.
  if (!isHtmlForm && page.url().startsWith(URLs.dash)) {
    if (await isDashSignedIn(page)) {
      logStep(`[step] signInToDash: SSO-cookie auto-login completed for ${email}`);
      return;
    }
  }
  if (isHtmlForm) {
    // HTML form (auth DESIGN §9a.8): stable ids #username/#password/#submit.
    await page.locator('#username').fill(email);
    await page.locator('#password').fill(password);
    clearAuthRateLimits(email);
    await page.locator('#submit').click();
  } else {
    await waitForFlutterSemantics(page, 2_000);
    await typeFlutterField(page, 'Email', email);
    await page.waitForTimeout(300);
    await typeFlutterField(page, 'Password', password);
    await page.waitForTimeout(300);
    // Clear rate limits again right before submitting - the form took
    // a few seconds to fill, and a previous test's sign-in may have
    // incremented the counter in that window.
    clearAuthRateLimits(email);
    // Submit the form by clicking the "Continue" button (same as signInOnAuth8).
    await clickFlutterButton(page, 'Continue', true);
    await page.waitForTimeout(500);
  }
  // Wait for redirect chain: /sign-in|/oauth/login → /oauth/authorize →
  // /auth/callback → dash
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (!page.url().includes('/sign-in') && !page.url().includes('/oauth/login')) {
      await page.goto(URLs.dash, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(500);
      return;
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`Timeout waiting for sign-in redirect (still on ${page.url()})`);
}

/** Sign out via the Flutter test bridge (clears cookies, redirects to /sign-in). */
export async function signOutViaUI(page: Page): Promise<void> {
  logStep(`[step] signOutViaUI: signing out via test bridge`);
  await waitForBridge(page, 'sentin8TestSignOut', 2_000);
  const ok = await callBridge(page, 'sentin8TestSignOut');
  if (!ok) throw new Error('sentin8TestSignOut bridge returned false');
  await waitForURLContains(page, '/sign-in', 2_000);
  try {
    await waitForFlutterText(page, 'Sign in', 2_000);
  } catch {
    // page might still be loading
    await page.waitForTimeout(500);
  }
}

/**
 * Sign up through Auth8: Dash → (redirect to /sign-in) → "Sign up"
 * (redirects to Auth8 /sign-up) → fill form → submit.
 * By the end of this call, the user has a __session cookie set.
 */
export async function signUpAs(
  page: Page,
  context: BrowserContext,
  email: string,
  firstName: string,
  lastName: string,
  password: string,
  _auth8Origin: string,
): Promise<void> {
  logStep(`[step] signUpAs: signing up ${email} (${firstName} ${lastName})`);
  // Do NOT clear cookies - see signInToDash for rationale.
  // Navigate to Dash with a cache-busting param to avoid cached redirects.
  await page.goto(`${URLs.dash}?_=${Date.now()}`, { waitUntil: 'domcontentloaded' });
  // Wait for the Dash sign-in page to render, then click "Sign up"
  // immediately (in the same evaluate call) to avoid a race condition
  // where the page navigates between the wait and the click.
  const deadline = Date.now() + 2_000;
  let clicked = false;
  while (Date.now() < deadline && !clicked) {
    try {
      const rect = await page.evaluate(() => {
        const els = document.querySelectorAll('flt-semantics');
        for (const el of Array.from(els)) {
          if (el.getAttribute('role') === 'button' && (el.textContent ?? '').includes('Sign up')) {
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }
        }
        return null;
      });
      if (rect) {
        await page.mouse.click(rect.x, rect.y);
        clicked = true;
      }
    } catch { /* page navigating - retry */ }
    if (!clicked) await page.waitForTimeout(200);
  }
  if (!clicked) throw new Error('Could not find and click "Sign up" on Dash sign-in page');
  // Wait for the Auth8 sign-up page to load.
  await page.waitForTimeout(500);
  await waitForFlutterSemantics(page, 2_000);
  await signUpOnAuth8(page, email, firstName, lastName, password);
}

/** Fill and submit the Auth8 sign-up form (shared by signUpAs and signUpViaApp). */
async function signUpOnAuth8(
  page: Page,
  email: string,
  firstName: string,
  lastName: string,
  password: string,
): Promise<void> {
  logStep(`[step] signUpOnAuth8: filling form for ${email}`);
  await waitForFlutterSemantics(page, 2_000);
  // The auth8-ui may land on the sign-in page first - click "Sign up"
  // to switch to the sign-up form, but only if the sign-up form isn't
  // already visible (e.g. when navigated directly to /sign-up).
  let hasSignUpForm = false;
  try {
    hasSignUpForm = await page.evaluate((needle: string) => {
      // Check flt-semantics (textContent + aria-label)
      const els = document.querySelectorAll('flt-semantics');
      for (const el of Array.from(els)) {
        const t = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`.toLowerCase();
        if (t.includes(needle)) return true;
      }
      // Check input/textarea elements (CanvasKit text fields)
      const inputs = document.querySelectorAll('input, textarea');
      for (const el of Array.from(inputs)) {
        const t = (el.getAttribute('aria-label') ?? '').toLowerCase();
        if (t.includes(needle)) return true;
      }
      return false;
    }, 'first name (optional)');
  } catch {
    // Navigation in progress - assume sign-up form not visible yet.
  }
  if (!hasSignUpForm) {
    await clickFlutterButton(page, 'Sign up');
    // The "Sign up" click may cause a full page navigation to /sign-up,
    // which requires Flutter to re-boot. Wait for the page to settle
    // and the sign-up form to appear.
    await page.waitForTimeout(500);
    await waitForFlutterSemantics(page, 2_000);
    await waitForFlutterText(page, 'First name (optional)', 2_000);
  }
  await typeFlutterField(page, 'First name (optional)', firstName);
  await typeFlutterField(page, 'Last name (optional)', lastName);
  await typeFlutterField(page, 'Email', email);
  await typeFlutterField(page, 'Password', password);
  await typeFlutterField(page, 'Confirm password', password);
  // Accept the Terms of Service checkbox (required by the sign-up form).
  await clickFlutterCheckbox(page, 'Terms of Service');
  // Submit the form by clicking the "Create account" button.
  // Try multiple approaches since CanvasKit buttons can be tricky.
  await clickFlutterButton(page, 'Create account');
  await page.waitForTimeout(300);
  // If the form is still visible (click didn't work), try pressing
  // Enter on the focused element.
  let stillOnSignUp = false;
  try {
    stillOnSignUp = await page.evaluate(() => {
      return !!document.querySelector('flt-semantics[role="checkbox"]');
    });
  } catch {
    // Execution context destroyed (navigation in progress) - the form
    // submitted successfully, so we're no longer on the sign-up page.
    stillOnSignUp = false;
  }
  if (stillOnSignUp) {
    await page.keyboard.press('Enter');
  }
  // Wait for the sign-up API response (Set-Cookie + redirect).
  await page.waitForTimeout(500);
}

export async function signInOnAuth8(page: Page, email: string, password: string): Promise<void> {
  clearAuthRateLimits(email);
  logStep(`[step] signInOnAuth8: signing in ${email}`);
  await waitForFlutterSemantics(page, 2_000);
  // Wait for the sign-in form to be ready before typing.
  await waitForFlutterText(page, 'Email', 2_000);
  await page.waitForTimeout(500);
  await typeFlutterField(page, 'Email', email);
  await page.waitForTimeout(300);
  await typeFlutterField(page, 'Password', password);
  await page.waitForTimeout(300);
  // Submit the form by clicking the "Continue" button. Use exact matching
  // to avoid clicking "Continue with SSO".
  await clickFlutterButton(page, 'Continue', true);
  // Wait for the sign-in API response (Set-Cookie + OAuth callback redirect).
  await page.waitForTimeout(500);
}

/** Sign up a customer through an app (e.g. eBank at www.ibank.local). */
export async function signUpViaApp(
  page: Page,
  context: BrowserContext,
  appURL: string,
  email: string,
  firstName: string,
  lastName: string,
  password: string,
): Promise<void> {
  logStep(`[step] signUpViaApp: signing up ${email} at ${appURL}`);
  // Navigate to the app. Retry on connection reset - the proxy may need
  // to fetch a TLS cert from ACME on the first request (1-2s).
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await page.goto(appURL, { waitUntil: 'domcontentloaded' });
      break;
    } catch (e) {
      lastErr = e;
      if (attempt < 2) {
        logStep(`signUpViaApp: retry ${attempt + 1}/3 after connection reset`);
        await page.waitForTimeout(500);
      }
    }
  }
  if (lastErr && !(await page.url()).includes(appURL.replace('https://', ''))) {
    throw lastErr;
  }
  await waitForFlutterSemantics(page, 2_000);
  // Click "Sign Up" on the LandingPage (retries a few times).
  let clicked = false;
  for (let i = 0; i < 3; i++) {
    try {
      await clickFlutterButton(page, 'Sign Up');
      clicked = true;
      break;
    } catch {
      await page.waitForTimeout(500);
    }
  }
  if (!clicked) throw new Error('Could not click Sign Up on app landing page');
  await waitForURLContains(page, '/sign-up', 2_000);
  await waitForFlutterSemantics(page, 2_000);
  await signUpOnAuth8(page, email, firstName, lastName, password);
  // After sign-up, the auth flow may either:
  // (a) redirect to /sign-in for the user to sign in, or
  // (b) go directly to the OAuth consent page (/oauth/authorize) if the
  //     sign-up auto-creates a session.
  // Handle both paths - poll for either URL pattern.
  let pathResolved = false;
  for (let retry = 0; retry < 30; retry++) {
    await page.waitForTimeout(1000);
    const url = page.url();
    if (url.includes('/sign-in')) {
      // Path (a): sign in with the new credentials.
      await waitForFlutterSemantics(page, 2_000);
      await signInOnAuth8(page, email, password);
      pathResolved = true;
      break;
    } else if (url.includes('/oauth/') || url.includes('authorize') || url.includes('/consent')) {
      // Path (b): consent page - click "Authorize" to continue.
      await waitForFlutterSemantics(page, 2_000);
      await page.waitForTimeout(2000);
      // The consent page's "Authorize" button triggers a POST to
      // /oauth/authorize/continue. Try multiple click strategies.
      let authorized = false;
      // Strategy 1: Playwright getByRole (most reliable for Flutter CanvasKit).
      try {
        const btn = page.getByRole('button', { name: 'Authorize', exact: true });
        if (await btn.count() > 0) {
          await btn.first().click({ force: true });
          await page.waitForTimeout(2000);
          authorized = !page.url().includes('/consent') && !page.url().includes('authorize');
        }
      } catch { /* fall through */ }
      // Strategy 2: coordinate-based click on flt-semantics.
      if (!authorized) {
        try {
          await clickFlutterButton(page, 'Authorize');
          await page.waitForTimeout(2000);
          authorized = !page.url().includes('/consent') && !page.url().includes('authorize');
        } catch { /* fall through */ }
      }
      // Strategy 3: dispatch click event directly on the semantics element.
      if (!authorized) {
        await page.evaluate(() => {
          const els = document.querySelectorAll('flt-semantics');
          for (const el of Array.from(els)) {
            const t = (el.textContent ?? '').trim();
            if (t === 'Authorize' && el.getAttribute('role') === 'button') {
              const r = (el as HTMLElement).getBoundingClientRect();
              el.dispatchEvent(new MouseEvent('click', {
                bubbles: true, cancelable: true,
                clientX: r.x + r.width / 2,
                clientY: r.y + r.height / 2,
              }));
              return;
            }
          }
        });
        await page.waitForTimeout(2000);
      }
      pathResolved = true;
      break;
    }
  }
  if (!pathResolved) {
    throw new Error(`signUpViaApp: unexpected URL after sign-up: ${page.url()}`);
  }
  // Wait for the OAuth callback to complete (BFF8 → /auth/callback → app).
  await page.waitForURL((u) => !u.toString().includes('auth.'), {
    timeout: 2_000,
  });
}

/** Sign in to a tenant Auth8 from the app URL. */
export async function signInToTenantAuth8(
  page: Page,
  context: BrowserContext,
  appURL: string,
  email: string,
  password: string,
): Promise<void> {
  clearAuthRateLimits(email);
  logStep(`[step] signInToTenantAuth8: signing in ${email} at ${appURL}`);
  // Do NOT clear cookies - see signInToDash for rationale.
  await page.goto(appURL, { waitUntil: 'domcontentloaded' });
  await waitForFlutterSemantics(page, 2_000);
  // The app may already have a valid BFF8 session (e.g. if the user
  // signed up moments ago and the session cookie is still valid). In
  // that case the app shows the authenticated dashboard directly - no
  // "Sign In" button. Check for "Sign In" first; if it's not visible
  // within a few seconds, assume we're already authenticated and skip
  // the sign-in flow.
  let needsSignIn = false;
  try {
    await waitForFlutterText(page, 'Sign In', 2_000);
    needsSignIn = true;
  } catch {
    // No "Sign In" button - already authenticated (dashboard visible).
  }
  if (!needsSignIn) {
    // Already authenticated - wait for the dashboard to settle and return.
    const authDeadline = Date.now() + 2_000;
    while (Date.now() < authDeadline) {
      const texts = await getFlutterTexts(page);
      if (texts.join(' ').toLowerCase().includes('products')) break;
      await page.waitForTimeout(500);
    }
    return;
  }
  // The app shows a landing page with "Sign In" and "Sign Up" buttons.
  // Click "Sign In" to redirect to the Auth8 sign-in page via BFF8 OAuth flow.
  await clickFlutterButton(page, 'Sign In');
  // Wait for redirect to auth8 sign-in page.
  await waitForURLContains(page, '/sign-in', 2_000);
  // Wait for the auth8 Flutter app to fully boot after the full page
  // navigation from the eBank app. The form fields need to be ready
  // before typing.
  await waitForFlutterSemantics(page, 2_000);
  await waitForFlutterText(page, 'Email', 2_000);
  await page.waitForTimeout(500);
  // Use the same signInOnAuth8 helper that signUpViaApp uses.
  await signInOnAuth8(page, email, password);
  // Wait for the OAuth callback redirect chain to complete.
  // auth8 /sign-in → /oauth/authorize → BFF8 /auth/callback → app URL.
  // The BFF8 callback creates the bff8-session cookie and redirects the
  // browser to the app frontend (derived from the OAuth `state`).
  const callbackDeadline = Date.now() + 2_000;
  while (Date.now() < callbackDeadline) {
    const url = page.url();
    if (!url.includes('/sign-in') && !url.includes('/oauth/') && !url.includes('/auth/callback')) {
      break; // Redirected to the app frontend - OAuth callback completed.
    }
    await page.waitForTimeout(500);
  }
  // The browser is now on the app frontend URL (e.g.
  // prod.ibank.ebank.app8.local.sentin8.dev) with the BFF8 session cookie set.
  // Wait for the Flutter app to boot. We do NOT navigate back to the
  // original appURL because it may be a custom domain (e.g. www.ibank.local)
  // that doesn't share the BFF8 session cookie's registrable domain.
  await waitForFlutterSemantics(page, 2_000);
  // Wait for the app to establish the BFF8 session and transition from
  // the login page to the authenticated dashboard. The app initially
  // shows the login page while the /auth/session check is in flight;
  // once the session is confirmed, it shows the dashboard with "Products"
  // (or "Sign In" disappears). Poll for up to 30 seconds.
  const authDeadline = Date.now() + 2_000;
  while (Date.now() < authDeadline) {
    const texts = await getFlutterTexts(page);
    const all = texts.join(' ');
    // If we see "Products" (sidebar item in eBank/efintech), we're authenticated.
    if (all.toLowerCase().includes('products')) break;
    // If we still see "Sign In", the session check hasn't completed yet.
    // Wait and retry.
    await page.waitForTimeout(500);
  }
}

// ── Org / env / settings UI helpers ───────────────────────────────────

/**
 * Override the org domain on the Create Organization page.
 *
 * The Create Org page uses the shared [ClickableSubdomainField] widget
 * (click-to-edit). The default platform domain is shown in read-only
 * mode (e.g. `{slug}.{DOMAIN}` - DOMAIN from the tree-root `.env`); clicking the field switches to
 * edit mode where the full value is editable in a single TextField
 * (no fixed suffix). The user types the custom domain, then clicks
 * the green tick icon to commit.
 *
 * @param page         Playwright page
 * @param orgSlug      The slug the user typed in the Organization Name
 *                     field. The platform default is `{slug}.o.{domain}`.
 * @param customDomain The desired custom domain, e.g. `iapp.local`.
 */
export async function setOrgDomainViaUI(
  page: Page,
  orgSlug: string,
  customDomain: string,
): Promise<void> {
  // Compute the platform default - this is the text shown in the
  // read-only display before we click into edit mode.
  const defaultDomain = `${orgSlug}.${DOMAIN}`;
  // Click the edit icon (a small inkwell wrapping the pencil icon)
  // to enter edit mode. The previous widget version made the whole
  // read-only text a tap target, which shifted focus to the first
  // form field (e.g. Organization Name) on click - breaking all
  // subsequent typing. The new design only the edit icon triggers
  // edit mode. The icon has a `tooltip: 'Edit'` and a unique
  // position in the row (between the text and the reset icon).
  await clickEditIcon(page);
  // Wait for the edit-mode TextField to appear. Flutter CanvasKit
  // mounts a new <input> element when the field enters edit mode but
  // its .value is empty until the input receives focus. Poll until we
  // see a fresh input with placeholder text like "e.g. ibank.local",
  // then focus it to flush the controller's value into the DOM.
  const editReadyDeadline = Date.now() + 2_000;
  let editReady = false;
  while (Date.now() < editReadyDeadline) {
    editReady = await page.evaluate((expected: string) => {
      const inputs = Array.from(document.querySelectorAll('input, textarea'));
      // The edit-mode input is the LAST mounted one; it has an empty
      // value and a placeholder like "e.g. ibank.local".
      for (let i = inputs.length - 1; i >= 0; i--) {
        const inp = inputs[i] as HTMLInputElement;
        if (inp.placeholder.startsWith('e.g.')) {
          inp.focus();
          return inp.value === expected;
        }
      }
      return false;
    }, defaultDomain);
    if (editReady) break;
    await page.waitForTimeout(100);
  }
  if (!editReady) {
    throw new Error(
      `setOrgDomainViaUI: edit-mode TextField for "${defaultDomain}" never appeared`,
    );
  }
  // The field's value is the platform default (e.g. "ibank.local.sentin8.dev").
  // Find the focused edit-mode <input> (which has the default value)
  // and atomically replace its value with the custom domain using the
  // native value setter so Flutter's TextEditingController listener fires.
  //
  // The ClickableSubdomainField uses a stable key on the TextField, so
  // focus is preserved across the value change. The native value setter
  // is preferred over keyboard.insertText because it sends a single
  // `input` event (vs. one per character), which matches what a paste
  // would do and avoids any chance of intermediate invalid states.
  const filled = await page.evaluate(({ defaultVal, targetVal }: { defaultVal: string; targetVal: string }) => {
    const inputs = Array.from(document.querySelectorAll('input, textarea'));
    // Walk backwards so we prefer the most-recently-mounted input
    // (the edit-mode one), which has the default value.
    for (let i = inputs.length - 1; i >= 0; i--) {
      const inp = inputs[i] as HTMLInputElement;
      if (inp.value === defaultVal || inp.placeholder.startsWith('e.g.')) {
        inp.focus();
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value',
        )?.set;
        if (setter) {
          setter.call(inp, targetVal);
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return true;
      }
    }
    return false;
  }, { defaultVal: defaultDomain, targetVal: customDomain });
  if (!filled) {
    // Fallback: focus the edit-mode input, select all, type the new value.
    await page.evaluate((defaultVal: string) => {
      const inputs = Array.from(document.querySelectorAll('input, textarea'));
      for (let i = inputs.length - 1; i >= 0; i--) {
        const inp = inputs[i] as HTMLInputElement;
        if (inp.value === defaultVal || inp.placeholder.startsWith('e.g.')) {
          inp.focus();
          return;
        }
      }
    }, defaultDomain);
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.keyboard.insertText(customDomain);
  }
  // Click the tick (Done) icon to commit the edit and return to
  // read-only mode. The shared widget exposes a tooltip of "Done"
  // on the green check icon.
  //
  // In Flutter CanvasKit the first click on Done often only marks
  // the button "active" without firing onPressed (a known quirk of
  // how Flutter Web translates PointerDown/PointerUp into a single
  // click). We click it a second time after a short pause so the
  // onPressed handler runs and exits edit mode.
  await clickFlutterButton(page, 'Done');
  await page.waitForTimeout(150);
  // Verify the read-only view now shows the typed value. If the
  // controller's text reverted to the default, the click on Done
  // may have hit a stale state. The Done button is known to need
  // a second click in Flutter CanvasKit; retry once before failing.
  let finalValue = await readOnlyDomain(page, customDomain);
  if (!finalValue) {
    await clickFlutterButton(page, 'Done');
    await page.waitForTimeout(200);
    finalValue = await readOnlyDomain(page, customDomain);
  }
  if (!finalValue) {
    throw new Error(
      `setOrgDomainViaUI: expected read-only display to contain "${customDomain}" after clicking Done`,
    );
  }
}

/**
 * Click the edit icon in the read-only ClickableSubdomainField to
 * switch it into edit mode.
 *
 * The widget renders the read-only state as a Row with:
 *   1. A non-clickable text label (the current value).
 *   2. The edit icon (an IconButton with tooltip "Edit") - this
 *      is the ONLY clickable affordance that triggers edit mode.
 *   3. A "Restore platform default" IconButton (also clickable).
 *
 * Flutter exposes the IconButton's tooltip as the flt-semantics
 * node's `textContent` (the `text` field in the accessibility tree).
 * We find the button by its visible text "Edit" and click it. If
 * multiple "Edit" buttons exist on the page, we pick the LAST one
 * (rightmost / lowest in DOM order) - the field's edit icon is
 * rendered after the text label and before the reset icon, in DOM
 * order. On the Create Org page there is only one such button.
 *
 * Why we can't use `clickFlutterButton('Edit')` directly: the edit
 * icon's flt-semantics node has empty `aria-label` but non-empty
 * `textContent`. clickFlutterButton matches against `text + aria-label`,
 * but its text-match uses lowercase substring, which would also
 * match "Created at", "Created by", etc. We want an EXACT match on
 * "Edit" to avoid those collisions.
 */
async function clickEditIcon(page: Page): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const rect = await page.evaluate(() => {
      const els = document.querySelectorAll('flt-semantics');
      let best: { x: number; y: number } | null = null;
      for (const el of Array.from(els)) {
        const role = el.getAttribute('role');
        if (role !== 'button') continue;
        // The IconButton with tooltip "Edit" has its tooltip text
        // rendered as the button's accessible text. Match exactly.
        const t = (el.textContent ?? '').trim();
        if (t !== 'Edit') continue;
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        if (!best || r.y > best.y) {
          best = { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        }
      }
      return best;
    });
    if (rect) {
      await page.mouse.click(rect.x, rect.y);
      return;
    }
    await page.waitForTimeout(100);
  }
  throw new Error('Could not find edit icon (button with text "Edit") on the page');
}

/**
 * Inspect the page semantics to find the read-only ClickableSubdomainField
 * value. In the new widget design, the read-only value is displayed as
 * plain Text (inside a Container), NOT as a button - the Edit icon is
 * the only clickable affordance. We look for any flt-semantics element
 * (generic, text, or button) whose text content matches the custom
 * domain. Returns the text if found, or empty string if still in edit
 * mode.
 */
async function readOnlyDomain(page: Page, customDomain: string): Promise<string> {
  return page.evaluate((expected: string) => {
    const els = document.querySelectorAll('flt-semantics');
    for (const el of Array.from(els)) {
      const t = (el.textContent ?? '').trim();
      if (t === expected) return t;
    }
    return '';
  }, customDomain);
}

export async function createOrganizationViaUI(
  page: Page,
  orgSlug: string,
  orgName: string,
  customDomain?: string,
): Promise<string> {
  logStep(`[step] createOrganizationViaUI: creating org slug=${orgSlug} name=${orgName} domain=${customDomain ?? '(default)'}`);
  // Navigate to the Create Org page explicitly - the Dash app may show
  // the main shell for users with sys:users role instead of auto-redirecting.
  await page.goto(`${URLs.dash}/#/org/create`, { waitUntil: 'domcontentloaded' });
  await waitForFlutterSemantics(page, 2_000);
  await waitForFlutterText(page, 'Organization Name', 2_000);
  await typeFlutterField(page, 'Organization Name', orgName);
  await page.waitForTimeout(300);
  // Type the custom domain if provided.  The org domain is now a
  // click-to-edit field (shared ClickableSubdomainField widget), not
  // a plain text field.  We click the read-only field, type into
  // the autofocused TextField, then click the tick to commit.
  if (customDomain) {
    await setOrgDomainViaUI(page, orgSlug, customDomain);
  }
  // Click the "Create" button. EXACT match - the org-picker page
  // (reachable in the stale semantics tree during the hash-route
  // transition) has a broader "Create Organization" button whose
  // includes-match would shadow the form's exact "Create" and
  // re-navigate to /org/create instead of submitting.
  //
  // RETRY LOOP: the form runs a debounced (500ms) slug-availability
  // check whose response triggers a setState that can SHIFT the button's
  // rect between the coordinate read and the mouse click - the first
  // click can land on stale coordinates and be silently ignored. Retry
  // (re-reading the rect each time) until the URL navigates or the
  // deadline passes; a submitted org navigates to /home?org={id}.
  const clickDeadline = Date.now() + 20_000;
  let submitted = false;
  while (Date.now() < clickDeadline && !submitted) {
    // Poll the URL until EITHER the org navigated (submitted) or a
    // short in-flight window passed - the POST /v1/o can take 4+ seconds
    // (provisioning is synchronous in-process, sys DESIGN §2), so the
    // poll window per click attempt must exceed that, not a fixed 2s.
    const attemptDeadline = Date.now() + 8_000;
    await clickFlutterButton(page, 'Create', true);
    while (Date.now() < attemptDeadline && !submitted) {
      await page.waitForTimeout(200);
      const u = page.url();
      if (u.includes('org=') && !u.includes('/org/create')) submitted = true;
    }
  }
  // Wait for redirect to the org page - the URL changes from /org/create
  // to /home?org={orgId} (query-param routing). Wait up to 10 seconds.
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const url = page.url();
    if (url.includes('org=') && !url.includes('/org/create')) break;
    await page.waitForTimeout(200);
  }
  // Give the RlsGuard time to check membership and render the org page.
  await page.waitForTimeout(500);
  // Extract the org ID from the URL (query-param: ?org={orgId} or path: /org/{orgId}).
  const url = page.url();
  const match = url.match(/[?&]org=([0-9a-f-]{36})/i) || url.match(/\/org\/([0-9a-f-]{36})/i);
  if (match) return match[1];
  // Dash didn't navigate - manually navigate back to the org picker
  // and click on the newly created org to enter it.
  logStep(`[step] createOrganizationViaUI: URL did not navigate (${url}), going back to org picker`);
  await page.goto(`${URLs.dash}`, { waitUntil: 'domcontentloaded' });
  await waitForFlutterSemantics(page, 2_000);
  // Wait for the org name to appear in the picker, then click it.
  await waitForFlutterText(page, orgName, 2_000);
  await clickFlutterButton(page, orgName);
  await page.waitForTimeout(500);
  await waitForFlutterSemantics(page, 2_000);
  // Extract the org ID from the URL (query-param or path).
  const url2 = page.url();
  const match2 = url2.match(/[?&]org=([0-9a-f-]{36})/i) || url2.match(/\/org\/([0-9a-f-]{36})/i);
  if (match2) return match2[1];
  throw new Error(`Could not extract org ID from URL: ${url2}`);
}

/** Create an environment in the given org via the Dash UI.  Returns the env ID. */
export async function createEnvironmentViaUI(
  page: Page,
  _orgID: string,
  envSlug: string,
  envName: string,
  envType: string,
): Promise<string> {
  logStep(`[step] createEnvironmentViaUI: creating env slug=${envSlug} name=${envName} type=${envType}`);
  // Click "Create Environment" on the org home page.
  await waitForFlutterSemantics(page, 2_000);
  await clickFlutterButton(page, 'Create Environment');
  // Wait for the env creation form to load.
  await page.waitForTimeout(500);
  // Fill in the environment name (slug is auto-generated).
  await waitForFlutterText(page, 'Environment Name', 2_000);
  await typeFlutterField(page, 'Environment Name', envName);
  await page.waitForTimeout(500); // Wait for slug auto-generation
  // Click the "Create" button (not "Create Environment").
  // Use evaluate to find the button with exact text "Create" (not "Create Environment").
  const rect = await page.evaluate(() => {
    const els = document.querySelectorAll('flt-semantics');
    for (const el of Array.from(els)) {
      if (el.getAttribute('role') === 'button' && (el.textContent ?? '').trim() === 'Create') {
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }
    }
    return null;
  });
  if (rect) {
    await page.mouse.click(rect.x, rect.y);
  } else {
    // EXACT match - the org-picker's "Create Organization" button would
    // shadow the form's "Create" on an includes-match (2026-10-10).
    await clickFlutterButton(page, 'Create', true);
  }
  // Wait for redirect to the env page. The app's Navigator state is the
  // authoritative signal - read it from the test bridge (sentin8TestGetLastRoute,
  // set by _generateRoute); the browser URL can lag the Navigator.
  const deadline = Date.now() + 10_000;
  let lastRoute = '';
  while (Date.now() < deadline) {
    lastRoute = await page.evaluate(() =>
      ((window as unknown as Record<string, () => string>).sentin8TestGetLastRoute?.() ?? '') as string,
    );
    if (/env=[0-9a-f-]{36}/i.test(lastRoute) || /\/env\/[0-9a-f-]{36}/i.test(lastRoute)) break;
    await page.waitForTimeout(200);
  }
  await page.waitForTimeout(500);
  // The create env page calls AuthProvider.instance.init() after creation,
  // which re-fetches the BFF8 session so the new env-admin role scopes are
  // picked up - no manual refresh needed.
  // Extract the env ID from the app's route (or the URL as a fallback).
  const routeMatch = lastRoute.match(/[?&]env=([0-9a-f-]{36})/i) || lastRoute.match(/\/env\/([0-9a-f-]{36})/i);
  if (routeMatch) return routeMatch[1];
  const url = page.url();
  const match = url.match(/[?&]env=([0-9a-f-]{36})/i) || url.match(/\/env\/([0-9a-f-]{36})/i);
  if (match) return match[1];
  // Diagnostic: the create page renders its failure in the form's error text
  // (create_environment_page sets _error on any exception between the POST
  // and the navigation). Dump whatever text the page shows so the client-side
  // failure is visible in the run log.
  const pageText = await page.evaluate(() =>
    Array.from(document.querySelectorAll('flt-semantics'))
      .map((el) => (el.textContent ?? '').trim())
      .filter((t) => t && (t.toLowerCase().includes('error') || t.toLowerCase().includes('exception') || t.toLowerCase().includes('failed')))
      .slice(0, 5)
      .join(' | '),
  );
  throw new Error(`Could not extract env ID from route "${lastRoute}" / URL: ${url}${pageText ? ` - page error: ${pageText}` : ''}`);
}

/** Set the auth domain for an env (toggles the hostname on Auth8 settings).
 *
 * With the subdomain-only UI, the authDomain parameter is parsed to extract
 * just the subdomain prefix (e.g. "auth" from "https://auth.ibank.local").
 * The org domain suffix is fixed and shown in the UI.
 */
export async function setAuthDomainViaUI(page: Page, orgID: string, envID: string, authDomain: string): Promise<void> {
  logStep(`[step] setAuthDomainViaUI: setting auth_domain=${authDomain} on org=${orgID} env=${envID}`);
  try { await waitForFlutterText(page, 'Environment', 2_000); } catch { /* */ }
  await page.waitForTimeout(500);
  await navigateViaSidebar(page, ['Auth', 'Settings']);
  await waitForFlutterSemantics(page, 2_000);
  await waitForFlutterText(page, 'Auth Domain', 2_000);
  // Extract the subdomain prefix from the full auth domain.
  // e.g. "https://auth.ibank.local" → "auth"
  const hostname = authDomain.replace(/^https?:\/\//, '').split('/')[0];
  const prefix = hostname.split('.')[0];
  await typeFlutterField(page, 'Subdomain', prefix);
  await clickFlutterButton(page, 'Save Auth Domain');
  await waitForFlutterText(page, 'saved', 2_000);
}

/**
 * Navigate to a page by clicking sidebar items (like a human would).
 * Expands parent items and clicks the child item.
 *
 * @param page    Playwright page
 * @param path    Array of sidebar labels to click, e.g. ['Ledg8', 'Products']
 */
export async function navigateViaSidebar(page: Page, path: string[]): Promise<void> {
  logStep(`[step] navigateViaSidebar: ${path.join(' > ')}`);
  // The last item in the path is the destination. Click each item in order.
  // For parent items (e.g. "Ledg8"), clicking expands the subtree.
  // For the leaf item (e.g. "Products"), clicking navigates to the page.
  //
  // The sidebar can have multiple buttons with the same label (e.g. "Settings"
  // appears at env level AND under Auth8). To disambiguate, we count how many
  // buttons with the leaf label existed *before* expanding the parent, then
  // click the one at that index (the newly-appeared child).
  let leafSkipCount = 0;
  for (let i = 0; i < path.length; i++) {
    const label = path[i];
    const isLast = i === path.length - 1;
    if (isLast) {
      // Leaf item - click the button at the calculated index to target the
      // child that appeared after parent expansion, not a top-level duplicate.
      // Try getByRole first, then fall back to coordinate-based click.
      //
      // Some sidebar labels carry a parenthetical that loads asynchronously
      // (e.g. "Organization (iBank)" - the "(iBank)" part comes from a
      // SYS8 fetch in _loadNames, which races with the test).  When the
      // fetch hasn't completed yet, the button is just "Organization" and
      // a substring match for "Organization (iBank)" fails.  We retry for
      // up to 10s, and as a last resort try matching the prefix before the
      // parenthesis (e.g. "Organization"), which is stable.
      const prefix = label.split(' (')[0];
      let clicked = false;

      // Helper: coordinate-based click on the Nth flt-semantics button
      // matching `needle` (handles CanvasKit zero-size elements by
      // walking parent rects).  Falls back to getByRole with force.
      const clickNth = async (needle: string, skip: number): Promise<boolean> => {
        const deadline = Date.now() + 2_000;
        while (Date.now() < deadline) {
          // Strategy 1: coordinate-based (works with zero-size flt-semantics)
          try {
            const rect = await page.evaluate(({ n, idx }: { n: string; idx: number }) => {
              const needle = n.toLowerCase();
              const els = document.querySelectorAll('flt-semantics');
              const matches: Element[] = [];
              for (const el of Array.from(els)) {
                const raw = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`;
                const t = raw.trim().toLowerCase();
                if (!t.includes(needle)) continue;
                const role = el.getAttribute('role');
                if (role !== 'button') continue;
                matches.push(el);
              }
              if (idx >= matches.length) return null;
              const el = matches[idx];
              let r = (el as HTMLElement).getBoundingClientRect();
              if (r.width === 0 && r.height === 0) {
                const parent = (el as HTMLElement).parentElement;
                if (parent) r = parent.getBoundingClientRect();
              }
              if (r.x > 0 || r.y > 0) {
                return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
              }
              return null;
            }, { n: needle, idx: skip });
            if (rect) {
              await page.mouse.click(rect.x, rect.y);
              return true;
            }
          } catch { /* fall through */ }
          // Strategy 2: getByRole with force (works when element has non-zero size)
          try {
            const btn = page.getByRole('button', { name: needle, exact: false });
            const count = await btn.count();
            if (count > skip) {
              await btn.nth(skip).click({ force: true });
              return true;
            }
          } catch { /* fall through */ }
          // Strategy 3: synthetic DOM click event (bypasses coordinate issues)
          try {
            const clicked = await page.evaluate(({ n, idx }: { n: string; idx: number }) => {
              const needle = n.toLowerCase();
              const els = document.querySelectorAll('flt-semantics');
              const matches: Element[] = [];
              for (const el of Array.from(els)) {
                const raw = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`;
                const t = raw.trim().toLowerCase();
                if (!t.includes(needle)) continue;
                if (el.getAttribute('role') !== 'button') continue;
                matches.push(el);
              }
              if (idx >= matches.length) return false;
              const el = matches[idx] as HTMLElement;
              let r = el.getBoundingClientRect();
              if (r.width === 0 && r.height === 0) {
                const parent = el.parentElement;
                if (parent) r = parent.getBoundingClientRect();
              }
              el.dispatchEvent(new MouseEvent('click', {
                bubbles: true, cancelable: true,
                clientX: r.x + r.width / 2,
                clientY: r.y + r.height / 2,
              }));
              return true;
            }, { n: needle, idx: skip });
            if (clicked) return true;
          } catch { /* fall through */ }
          await page.waitForTimeout(200);
        }
        return false;
      };

      // Primary: try getByRole click (most reliable for Flutter CanvasKit).
      try {
        const btn = page.getByRole('button', { name: label, exact: false });
        const count = await btn.count();
        if (count > leafSkipCount) {
          await btn.nth(leafSkipCount).click({ force: true });
          clicked = true;
        }
      } catch { /* fall through to coordinate-based */ }
      if (clicked) await page.waitForTimeout(500);

      // Fallback: index-aware coordinate click (respects leafSkipCount).
      if (!clicked) {
        clicked = await clickNth(label, leafSkipCount);
        if (clicked) await page.waitForTimeout(500);
      }

      // Fallback: try the parenthetical-free prefix (handles the
      // _loadNames race where "(iBank)" hasn't loaded yet).
      if (!clicked && prefix !== label) {
        clicked = await clickNth(prefix, leafSkipCount);
        if (clicked) await page.waitForTimeout(500);
      }

      if (!clicked) {
        // Final fallback: non-indexed coordinate click (retries for 10s).
        await clickFlutterButton(page, label);
        await page.waitForTimeout(500);
      }
    } else {
      // Parent item - click to expand. Use getByRole for reliability.
      // Count how many buttons with the *next* label exist before expansion
      // so we can skip them when clicking the leaf.
      const nextLabel = path[i + 1];
      const beforeCount = await page.getByRole('button', { name: nextLabel, exact: false }).count();

      // If the child is already visible (beforeCount > 0), the parent
      // is likely already expanded from a previous navigation (e.g. the
      // second call to createListingViaUI navigates App8 > Store again).
      // We still try the expansion strategies below - if the parent was
      // NOT actually expanded (the child label exists elsewhere, e.g.
      // "Settings" appears as both an env-level item AND an FDX8 child),
      // the strategies will expand it and produce more child buttons.
      // If the parent WAS already expanded, the click might collapse it,
      // so the strategies check afterCount > beforeCount and only mark
      // expanded=true when new children appeared.
      let expanded = beforeCount > 0;
      let effectiveBeforeCount = beforeCount;

      // Try multiple click strategies. Flutter CanvasKit InkWell can be
      // finicky - try getByRole click, then coordinate-based click, then
      // direct DOM click on the semantics element.
      // Always run these - even when expanded=true, because the parent
      // might not actually be expanded (beforeCount > 0 from a different
      // source). The strategies only set expanded=true when afterCount
      // increases, so a no-op click on an already-expanded parent is safe.
      {

      // Strategy 1: getByRole click with pointer-events disabled
      try {
        const btn = page.getByRole('button', { name: label, exact: false });
        if (await btn.count() > 0) {
          // Disable pointer-events on flt-semantics overlays so the click
          // reaches the canvas underneath.
          await page.evaluate(() => {
            const container = document.querySelector('flt-semantics-host');
            if (container) (container as HTMLElement).style.pointerEvents = 'none';
            document.querySelectorAll('flt-semantics').forEach(el => {
              (el as HTMLElement).style.pointerEvents = 'none';
            });
          });
          await btn.first().click({ force: true });
          await page.waitForTimeout(1000);
          // Restore pointer events.
          await page.evaluate(() => {
            const container = document.querySelector('flt-semantics-host');
            if (container) (container as HTMLElement).style.pointerEvents = '';
            document.querySelectorAll('flt-semantics').forEach(el => {
              (el as HTMLElement).style.pointerEvents = '';
            });
          });
          const afterCount = await page.getByRole('button', { name: nextLabel, exact: false }).count();
          if (afterCount > effectiveBeforeCount) {
            expanded = true;
            effectiveBeforeCount = afterCount;
          }
        }
      } catch { /* fall through */ }

      // Strategy 2: coordinate-based click with pointer-events disabled
      // Flutter CanvasKit flt-semantics elements may have zero size.
      // We find the element (even with zero size), get its x/y, disable
      // pointer-events on the overlay, and use a proper tap gesture.
      if (!expanded) {
        try {
          const coords = await page.evaluate((needle: string) => {
            const n = needle.toLowerCase();
            const els = document.querySelectorAll('flt-semantics');
            for (const el of Array.from(els)) {
              const raw = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`;
              const t = raw.trim().toLowerCase();
              if (!t.includes(n)) continue;
              const role = el.getAttribute('role');
              if (role !== 'button') continue;
              // The element's x/y are valid even when width/height are 0.
              let r = (el as HTMLElement).getBoundingClientRect();
              if (r.width === 0 && r.height === 0) {
                // Try parent's rect (the InkWell/Container wrapper)
                const parent = (el as HTMLElement).parentElement;
                if (parent) {
                  r = parent.getBoundingClientRect();
                }
              }
              // Use x/y even if still zero-size - CanvasKit places
              // flt-semantics at the correct canvas coordinates.
              if (r.x > 0 || r.y > 0) {
                return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
              }
            }
            return null;
          }, label);
          if (coords) {
            // Disable pointer-events on ALL flt-semantics overlays so
            // the mouse event reaches the canvas (same technique as
            // clickFlutterCheckbox).
            await page.evaluate(() => {
              const container = document.querySelector('flt-semantics-host');
              if (container) (container as HTMLElement).style.pointerEvents = 'none';
              document.querySelectorAll('flt-semantics').forEach(el => {
                (el as HTMLElement).style.pointerEvents = 'none';
              });
            });
            // Use a proper tap gesture (move→down→wait→up).
            await page.mouse.move(coords.x, coords.y);
            await page.mouse.down();
            await page.waitForTimeout(50);
            await page.mouse.up();
            await page.waitForTimeout(1000);
            // Restore pointer events.
            await page.evaluate(() => {
              const container = document.querySelector('flt-semantics-host');
              if (container) (container as HTMLElement).style.pointerEvents = '';
              document.querySelectorAll('flt-semantics').forEach(el => {
                (el as HTMLElement).style.pointerEvents = '';
              });
            });
            const afterCount = await page.getByRole('button', { name: nextLabel, exact: false }).count();
            if (afterCount > effectiveBeforeCount) {
              expanded = true;
              effectiveBeforeCount = afterCount;
            }
          }
        } catch { /* fall through */ }
      }

      // Strategy 3: direct DOM click on the flt-semantics element
      if (!expanded) {
        try {
          const clicked = await page.evaluate((needle: string) => {
            const n = needle.toLowerCase();
            const els = document.querySelectorAll('flt-semantics');
            for (const el of Array.from(els)) {
              const raw = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`;
              const t = raw.trim().toLowerCase();
              if (!t.includes(n)) continue;
              const r = (el as HTMLElement).getBoundingClientRect();
              if (r.width === 0 && r.height === 0) continue;
              const role = el.getAttribute('role');
              if (role === 'button') {
                // Dispatch a click event directly on the semantics element.
                el.dispatchEvent(new MouseEvent('click', {
                  bubbles: true, cancelable: true,
                  clientX: r.x + r.width / 2,
                  clientY: r.y + r.height / 2,
                }));
                return true;
              }
            }
            return false;
          }, label);
          if (clicked) {
            await page.waitForTimeout(1000);
            const afterCount = await page.getByRole('button', { name: nextLabel, exact: false }).count();
            if (afterCount > effectiveBeforeCount) {
              expanded = true;
              effectiveBeforeCount = afterCount;
            }
          }
        } catch { /* fall through */ }
      }

      // Set the skip count for the leaf - always, even when the parent
      // was already expanded.  This ensures the leaf click skips the
      // pre-existing buttons with the same label (e.g. the env-level
      // "Settings" button when expanding FDX8 to click its "Settings"
      // child) and targets the correct child.
      //
      // When the parent was NOT expanded (strategies ran), beforeCount
      // counts only the pre-existing buttons → leafSkipCount = beforeCount
      // skips them all and clicks the newly-appeared child.
      //
      // When the parent was ALREADY expanded (beforeCount > 0, strategies
      // skipped), beforeCount includes both the pre-existing buttons AND
      // the child buttons → leafSkipCount = beforeCount - 1 targets the
      // last child (children are appended after top-level items in the
      // accessibility tree).
      // Set the skip count for the leaf.
      // When the parent was NOT expanded (no new children appeared),
      // effectiveBeforeCount == beforeCount - the child is already visible
      // at its existing index, so leafSkipCount = 0 (don't skip it).
      // When the strategies DID expand the parent (new children appeared),
      // effectiveBeforeCount == afterCount (the new total) - but we want
      // to click the child that JUST appeared, which is at index
      // (beforeCount) - the count of buttons before expansion.
      if (i + 1 === path.length - 1) {
        leafSkipCount = effectiveBeforeCount > beforeCount ? beforeCount : 0;
      }
      } // end of expansion strategies block

      // If the child still isn't visible, try scrolling the sidebar down
      // to reveal off-screen children (Flutter ListView lazy-builds children).
      if (!expanded) {
        // Scroll the sidebar down by scrolling the page content.
        await page.mouse.wheel(0, 300);
        await page.waitForTimeout(500);
        // Also try scrolling within the sidebar via keyboard.
        await page.keyboard.press('PageDown');
        await page.waitForTimeout(500);

        // After scrolling, re-check if the child appeared.
        const afterScrollCount = await page.getByRole('button', { name: nextLabel, exact: false }).count();
        if (afterScrollCount > effectiveBeforeCount) {
          expanded = true;
          effectiveBeforeCount = afterScrollCount;
        }
      }

      // Even if the parent expanded, the child may be below the fold.
      // Scroll down to reveal it before the leaf click.
      if (expanded) {
        for (let scrollAttempt = 0; scrollAttempt < 5; scrollAttempt++) {
          // Check if the child button is visible (in viewport).
          const isVisible = await page.evaluate(({ n }: { n: string }) => {
            const needle = n.toLowerCase();
            const els = document.querySelectorAll('flt-semantics');
            for (const el of Array.from(els)) {
              const raw = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`;
              if (raw.trim().toLowerCase().includes(needle) && el.getAttribute('role') === 'button') {
                const r = (el as HTMLElement).getBoundingClientRect();
                if (r.y > 0 && r.y < window.innerHeight && r.width > 0) return true;
              }
            }
            return false;
          }, { n: nextLabel });
          if (isVisible) break;
          await page.mouse.wheel(0, 200);
          await page.waitForTimeout(200);
        }
      }

      // Fail fast: if the parent never expanded, the navigation is broken.
      // Continuing silently leads to confusing failures much later in the
      // test (wrong page loaded, element not found, browser closed, etc.).
      if (!expanded && i < path.length - 1) {
        throw new Error(
          `navigateViaSidebar: failed to expand parent item "${label}" (child "${nextLabel}" never appeared after all strategies + scroll)`,
        );
      }
    }
  }
  await waitForFlutterSemantics(page, 500);
}

/**
 * Enable a list of platform features (e.g. storage, db, func) for the
 * given env. Toggles each feature switch - toggling now saves
 * automatically (no separate Save button).
 * Navigates via the sidebar (like a human) - no direct URL redirects.
 */
/**
 * Map a feature key (e.g. "storage") to the display name shown in the
 * Dash env settings page (e.g. "Storage"). Platform features use
 * simple names; vertical features (bank8) are added by the vertical's
 * own harness extension.
 */
export function featDisplayName(feat: string): string {
  const FEATURE_DISPLAY: Record<string, string> = {
    auth: 'Auth',
    app: 'App',
    db: 'DB',
    storage: 'Storage',
    func: 'Func',
    cron: 'Cron',
    flow: 'Flow',
    stat: 'Stat',
    bus: 'Bus',
    post: 'Post',
  };
  return FEATURE_DISPLAY[feat] ?? feat.split('_').map(w => w[0].toUpperCase() + w.slice(1)).join(' ');
}

export async function enableFeatureViaUI(page: Page, orgID: string, envID: string, ...features: string[]): Promise<void> {
  logStep(`[step] enableFeatureViaUI: org=${orgID} env=${envID} features=[${features.join(', ')}]`);
  // Wait for the sidebar to show "Settings" - confirms DashShell rebuilt.
  await waitForFlutterText(page, 'Settings', 2_000);
  await page.waitForTimeout(500);
  // Navigate to the env settings page via sidebar.
  await navigateViaSidebar(page, ['Environment']);
  await page.waitForTimeout(500);
  await navigateViaSidebar(page, ['Settings']);
  await waitForFlutterSemantics(page, 2_000);
  // Wait for the "Services" heading to confirm we're on the settings page.
  await waitForFlutterText(page, 'Services', 2_000);
  // Click each feature's "Enable {DisplayName}" button - each click auto-saves.
  // The display name comes from the UI's _FeatureMeta in env_settings_page.dart.
  for (const feat of features) {
    const displayLabel = featDisplayName(feat);
    const enableBtn = `Enable ${displayLabel}`;
    // Check if the feature is already enabled (button shows "Enabled" not "Enable X").
    // If already enabled, skip - no need to click.
    // Check if "Enable {displayLabel}" text exists on the page.
    // If it doesn't but "Enabled" buttons exist, the feature is already on.
    const hasEnableButton = await page.evaluate((needle: string) => {
      const els = document.querySelectorAll('flt-semantics');
      for (const el of Array.from(els)) {
        const t = (el.textContent ?? '').trim();
        if (t === needle) return true;
      }
      return false;
    }, enableBtn);
    if (!hasEnableButton) {
      logStep(`[step] enableFeatureViaUI: ${feat} already enabled (no "${enableBtn}" button found) - skipping`);
      continue;
    }
    // Wait for the button to appear.
    await waitForFlutterText(page, enableBtn, 2_000);
    // Wait for the page to stabilize after the previous click.
    await page.waitForTimeout(500);
    // Click the enable button using clickFlutterButton (dispatches
    // synthetic mouse events that work on Flutter CanvasKit).
    // Disable pointer-events on flt-semantics overlays first.
    await page.evaluate(() => {
      document.querySelectorAll('flt-semantics').forEach(el => {
        (el as HTMLElement).style.pointerEvents = 'none';
      });
    });
    try {
      await clickFlutterButton(page, enableBtn, false);
      await page.waitForTimeout(2000);
      logStep(`[step] enableFeatureViaUI: ${feat} enabled (clicked "${enableBtn}")`);
    } catch (e) {
      // Try case-insensitive match (e.g. "Enable FDX" vs "Enable Fdx")
      try {
        await clickFlutterButton(page, `Enable ${displayLabel}`, false);
        await page.waitForTimeout(2000);
        logStep(`[step] enableFeatureViaUI: ${feat} enabled (clicked via case-insensitive match)`);
      } catch (e2) {
        logStep(`[step] enableFeatureViaUI: ${feat} - could not click "${enableBtn}": ${e2}`);
      }
    }
    await page.evaluate(() => {
      document.querySelectorAll('flt-semantics').forEach(el => {
        (el as HTMLElement).style.pointerEvents = '';
      });
    });
  }
  // The sidebar picks up feature changes immediately via AuthProvider
  // notifications - no page reload needed. Just wait for semantics to settle.
  await waitForFlutterSemantics(page, 500);
}

/**
 * Enable this env as an FDX Data Provider through the Dash FDX8
 * Settings UI.  Navigates to FDX8 → Settings (the env-scoped page at
 * `?env={envId}` → fdx8/settings) and clicks the
 * "Enable Data Provider" button.  The page auto-saves on click.
 *
 * The FDX8 *feature* must already be enabled (call
 * `enableFeatureViaUI(..., 'fdx8')` first) - the Settings page shows
 * "feature not enabled" otherwise.
 *
 * @returns true if the button transitioned to "Enabled" (i.e. the env
 *   was newly enabled), false if it was already enabled.
 */
export async function enableFdxDataProviderViaUI(
  page: Page,
  _orgID: string,
  _envID: string,
): Promise<boolean> {
  logStep(`[step] enableFdxDataProviderViaUI: org=${_orgID} env=${_envID}`);
  // Wait for the FDX8 sidebar item to appear - it only shows after the
  // fdx8 feature is enabled. The sidebar rebuilds async via
  // AuthProvider.notifyFeatureChange() → _reloadFeatures().
  await waitForFlutterText(page, 'FDX', 2_000);
  await page.waitForTimeout(500);
  // Navigate to the FDX8 Settings page via the env-scoped sidebar.
  await navigateViaSidebar(page, ['FDX', 'Settings']);
  await waitForFlutterSemantics(page, 2_000);
  // Wait for the FDX Data Provider card to render.
  await waitForFlutterText(page, 'FDX Data Provider', 2_000);
  // The button text is "Enable Data Provider" (when disabled) or
  // "Enabled" (when already on).  Click the button either way to
  // ensure the page is in the expected state.  We read the current
  // text first to know whether we just enabled it (idempotent).
  const wasEnabled = await page.evaluate(() => {
    const els = document.querySelectorAll('flt-semantics');
    for (const el of Array.from(els)) {
      const role = el.getAttribute('role');
      const t = (el.textContent ?? '').trim();
      if (role === 'button' && t === 'Enabled') return true;
    }
    return false;
  });
  if (wasEnabled) return false;
  await clickFlutterButton(page, 'Enable Data Provider');
  // The page auto-saves on click and the button label flips to
  // "Enabled". Wait for the flip to confirm persistence.
  await waitForFlutterText(page, 'Enabled', 2_000);
  return true;
}

/**
 * Create an App8 store listing through the env-scoped App Store UI.
 * Returns the listing ID (read from the page after submit).
 *
 * Scopes and roles are entered through the new [ScopeSelector] and
 * [RoleSelector] widgets (chip-based, autocomplete) rather than the
 * old comma/newline-separated textboxes.  Each scope is added one
 * at a time by clicking the input and pressing Enter; each role is
 * added by clicking the "Add Role" button then filling its name,
 * description, and nested scope input.  This exercises the real
 * widget code paths (not a backdoor API or textual bridge).
 *
 *   The new [RoleSelector] picker uses an autocomplete text
 *   input (same widget as the platform scope selector) instead
 *   of FilterChips.  The user types the included role name and
 *   presses Enter to commit; selected roles then appear as
 *   removable `InputChip`s below the input.  This exercise drives
 *   the real widget code path.
 *
 * @param scopes  Optional space/comma-separated OAuth scopes the
 *   app requires.  Each scope is added individually to the
 *   OAuth Scopes selector.
 */
export async function createListingViaUI(
  page: Page,
  appName: string,
  appSlug: string,
  description: string,
  _backendUrl: string,
  scopes?: string,
): Promise<string> {
  logStep(`[step] createListingViaUI: appName=${appName} slug=${appSlug} scopes=${scopes ?? '(none)'}`);
  // Wait for the sidebar to show "App8" - this confirms the
  // DashShell has rebuilt after refreshAndInit and _loadNames()
  // has fetched the env features (app8 is enabled by default).
  // Without this wait, navigateViaSidebar(['App', 'Store']) fails
  // because the "App8" sidebar item hasn't been rendered yet.
  await waitForFlutterText(page, 'App', 2_000);
  await page.waitForTimeout(500);
  // Navigate to the App8 Store page via sidebar, then click "Publish New App".
  await navigateViaSidebar(page, ['App', 'Store']);
  await waitForFlutterSemantics(page, 2_000);
  // Wait for the "Publish New App" button to appear on the store page.
  await waitForFlutterText(page, 'Publish New App', 2_000);
  // Click "Publish New App" to open the creation form.
  await clickFlutterButton(page, 'Publish New App');
  await page.waitForTimeout(500);
  // Fill in the form.  Known textbox order in the create form:
  //   0 = App Name, 1 = Description, 2 = Backend URL,
  //   3 = outer OAuth Scopes input.
  await waitForFlutterText(page, 'App Name', 2_000);
  await typeFlutterField(page, 'App Name', appName);
  await page.waitForTimeout(100);
  await typeFlutterField(page, 'Description', description);
  await page.waitForTimeout(100);
  try { await typeFlutterField(page, 'Backend URL', _backendUrl); await page.waitForTimeout(100); } catch { /* no backend URL field */ }
  // OAuth scopes (optional) - submit the whole list at once as a
  // comma-separated string.  The [ScopeSelector] widget splits on
  // `,`/whitespace and adds all valid scopes in one pass.
  if (scopes && scopes.length > 0) {
    const scopeList = scopes.split(/[\s,]+/).filter((s) => s.length > 0);
    await addScopesBatchViaUI(page, scopeList, 3);
  }
  // Security groups are NO LONGER declared on the listing - they are
  // materialized per-instance at install time based on instanceName.
  // See Epic 12.4 / design/sentin8-app8-technical-design.md §4.1.1.
  // Click "Create & Publish" to submit.
  await scrollFlutterButtonIntoView(page, 'Create & Publish');
  await clickFlutterButton(page, 'Create & Publish');
  // Give the POST + status update time to complete and the page to
  // re-render with the new listing.
  await page.waitForTimeout(500);

  // Get the listing ID from the Flutter app's test bridge - the ID is set
  // by the same _createListing() method that the "Create & Publish" button
  // triggers, so this is UI-driven (no direct API call).  Poll for up
  // to 5 seconds since the bridge value is set after the POST returns.
  let listingId = '';
  const bridgeDeadline = Date.now() + 2_000;
  while (Date.now() < bridgeDeadline) {
    listingId = await page.evaluate(
      () => (window as any).sentin8TestGetLastListingId?.() ?? '',
    );
    if (listingId) break;
    await page.waitForTimeout(300);
  }
  if (listingId) return listingId;
  // Fallback: verify the listing was found on the page at least.
  throw new Error(`Could not verify listing creation for "${appName}" (slug: ${appSlug}) - page navigated but app name not found on listings page`);
}

/** Set org branding (logo URL, primary/accent colors, font, theme). */
export async function setOrgBrandingViaUI(
  page: Page,
  orgID: string,
  logoUrl: string,
  primary: string,
  accent: string,
  font: string,
  iconUrl: string,
  theme: string,
): Promise<void> {
  // Wait for sidebar to be ready before navigating.
  try { await waitForFlutterText(page, 'Environment', 2_000); } catch { /* */ }
  await page.waitForTimeout(500);
  // Navigate to the org-level branding page via sidebar.
  await navigateViaSidebar(page, ['Branding']);
  await waitForFlutterSemantics(page, 2_000);
  await waitForFlutterText(page, 'Logo URL', 2_000);
  await typeFlutterField(page, 'Logo URL', logoUrl);
  await typeFlutterField(page, 'Logo Icon URL', iconUrl);
  await typeFlutterField(page, 'Primary Color', primary);
  await typeFlutterField(page, 'Accent Color', accent);
  await typeFlutterField(page, 'Font Family', font);
  // Select the theme mode - click the appropriate ChoiceChip.
  // Flutter renders ChoiceChip as a `checkbox` role in the accessibility
  // tree (it has a `selected` boolean state), not as a `button`. Use the
  // `checkbox` role and fall back to `button` if the version of Flutter
  // changes that later.
  const clickChip = async (label: 'Light' | 'Dark') => {
    for (const role of ['checkbox', 'button'] as const) {
      const chip = page.getByRole(role, { name: label, exact: true });
      if ((await chip.count()) > 0) {
        await chip.first().click({ force: true });
        await page.waitForTimeout(300);
        return;
      }
    }
    // Last resort: click the text node by coordinate.
    await clickFlutterButton(page, label);
    await page.waitForTimeout(300);
  };
  if (theme === 'light') {
    await clickChip('Light');
  } else if (theme === 'dark') {
    await clickChip('Dark');
  } else {
    // Default (Dark) - no click needed (it's the default).
  }
  // Scroll to the bottom to ensure the Save button is visible.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(500);
  // Try clicking Save via getByRole first (handles scroll-into-view).
  let saveClicked = false;
  try {
    const saveBtn = page.getByRole('button', { name: 'Save', exact: true });
    if ((await saveBtn.count()) > 0) {
      await saveBtn.first().click({ force: true });
      saveClicked = true;
    }
  } catch { /* fall through to clickFlutterButton */ }
  if (!saveClicked) {
    await clickFlutterButton(page, 'Save');
  }
  // The branding page shows "Saved" on success or "Error: ..." on failure.
  // Wait for either.
  await waitForFlutterText(page, 'Saved', 2_000);
}

// ── Assertions ────────────────────────────────────────────────────────

export async function assertSessionCookieSet(context: BrowserContext, name: string = '__session'): Promise<void> {
  const cookies = await context.cookies();
  const has = cookies.some((c) => c.name === name && c.value.length > 0);
  expect(has, `expected cookie ${name} to be set`).toBe(true);
}

export async function assertOnDash(page: Page): Promise<void> {
  // DERIVED from the suite's domain (e2e DESIGN §4 invariant 5) - never a
  // hardcoded hostname literal.
  expect(page.url()).toContain(`dash.ops.sys.${DOMAIN}`);
}

// ── Storage file upload via Dash UI ───────────────────────────────────

/**
 * Upload one or more files to org-level Storage storage through the Dash
 * Storage UI. Navigates to the Storage overview page, clicks "Upload File",
 * uses the native file picker dialog to select a file, then clicks "Upload".
 *
 * @param page      Playwright page
 * @param orgID     Organization ID
 * @param envID     Environment ID (empty string for org-scoped)
 * @param filePaths Array of absolute paths to files to upload
 */
export async function uploadFilesToStorageViaUI(
  page: Page,
  orgID: string,
  envID: string,
  filePaths: string[],
): Promise<void> {
  logStep(`[step] uploadFilesToStorageViaUI: org=${orgID} env=${envID || '(org)'} files=[${filePaths.map(p => p.split('/').pop()).join(', ')}]`);

  // Wait for the env-level sidebar to load the dynamic service items.
  await waitForFlutterText(page, 'Storage', 2_000);

  // Navigate to Storage > Buckets via the sidebar navigation helper
  // which has multi-strategy parent expansion (coordinate click, getByRole,
  // synthetic DOM click, scroll). This is more reliable than dispatching
  // synthetic pointer events on the canvas.
  await navigateViaSidebar(page, ['Storage', 'Buckets']);
  await waitForFlutterSemantics(page, 2_000);

  // Create a "branding" bucket if it doesn't exist.
  // Check if "branding" appears on the page (it would be a bucket name).
  const hasBrandingBucket = await page.evaluate(() => {
    const els = document.querySelectorAll('flt-semantics');
    for (const el of Array.from(els)) {
      if ((el.textContent ?? '').includes('branding')) return true;
    }
    return false;
  });

  if (!hasBrandingBucket) {
    logStep('[step] uploadFilesToStorageViaUI: creating "branding" bucket');
    await clickFlutterButton(page, 'Create Bucket');
    await waitForFlutterText(page, 'Bucket Name', 2_000);
    await typeFlutterField(page, 'Bucket Name', 'branding');
    await clickFlutterButton(page, 'Create Bucket');
    await waitForFlutterSemantics(page, 2_000);
    await page.waitForTimeout(500);
  }

  // Navigate into the "branding" bucket - click "View" near the "branding" text.
  // Wait for the DataTable to load the bucket row (FutureBuilder fetch).
  await waitForFlutterText(page, 'branding', 2_000);
  await page.waitForTimeout(500);
  await clickFlutterButtonNearText(page, 'View', 'branding', 2_000);
  await waitForFlutterSemantics(page, 2_000);
  // The bucket detail page has an inline upload form with "Select File" and
  // an "Upload" submit button. No separate upload page navigation needed.

  for (const filePath of filePaths) {
    const fileName = filePath.split('/').pop() ?? '';

    // Wait for the "Select File" label (inline upload form on bucket detail page).
    await waitForFlutterText(page, 'Select File', 2_000);

    // Use the native file picker dialog.
    const fileChooserPromise = page.waitForEvent('filechooser', { timeout: 2_000 });
    await clickFlutterButton(page, 'Choose File');
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(filePath);

    // Wait for the file name to appear (confirms the file was read).
    await waitForFlutterText(page, fileName, 2_000);

    // Click the "Upload" submit button.
    await clickFlutterButton(page, 'Upload');
    await waitForFlutterSemantics(page, 2_000);
    await page.waitForTimeout(500);

    // Verify the upload succeeded - check for error text on the page.
    const hasError = await page.evaluate(() => {
      const els = document.querySelectorAll('flt-semantics');
      for (const el of Array.from(els)) {
        const t = (el.textContent ?? '').toLowerCase();
        if (t.includes('error') || t.includes('failed') || t.includes('422') || t.includes('invalid')) {
          return true;
        }
      }
      return false;
    });
    if (hasError) {
      // Read the error message for diagnostics.
      const errMsg = await page.evaluate(() => {
        const els = document.querySelectorAll('flt-semantics');
        for (const el of Array.from(els)) {
          const t = (el.textContent ?? '').toLowerCase();
          if (t.includes('error') || t.includes('failed') || t.includes('422') || t.includes('invalid')) {
            return el.textContent ?? '';
          }
        }
        return 'unknown error';
      });
      throw new Error(`uploadFilesToStorageViaUI: upload of ${fileName} failed: ${errMsg}`);
    }

    logStep(`[step] uploadFilesToStorageViaUI: uploaded ${fileName} to bucket "branding"`);
  }
}

/**
 * Upload a single file to Storage via the Dash UI.
 * Convenience wrapper around uploadFilesToStorageViaUI for a single file.
 */
export async function uploadFileToStorageViaUI(
  page: Page,
  orgID: string,
  envID: string,
  filePath: string,
): Promise<void> {
  await uploadFilesToStorageViaUI(page, orgID, envID, [filePath]);
}

/**
 * Create a user via the Dash Auth8 admin UI.
 * Navigates to Auth8 → Users, clicks "Create User", fills the dialog
 * (first name, last name, email, password), and submits.
 *
 * For org-scoped staff users, pass the staff env ID - the function navigates
 * to that env's Auth > Users page (Auth is env-scoped, so we must be in an
 * env to see the Auth sidebar item).
 *
 * @param page     Playwright page
 * @param scope    'org' for org-scoped Auth8 (Staff), 'env' for env-scoped
 * @param user     { email, firstName, lastName, password, group? }
 * @param envId    The env ID to navigate to (required for scope='org')
 */
export async function createUserViaUI(
  page: Page,
  scope: 'org' | 'env',
  user: { email: string; firstName: string; lastName: string; password: string; group?: string },
  envId?: string,
  envName?: string,
): Promise<void> {
  logStep(`[step] createUserViaUI: scope=${scope} email=${user.email} (${user.firstName} ${user.lastName})`);
  // Auth is env-scoped - navigate to the env's Auth > Users via sidebar.
  if (scope === 'org' && envId) {
    // Navigate to org home, then click into the target env to enter env scope.
    await navigateViaSidebar(page, ['Organization']);
    await waitForFlutterSemantics(page, 2_000);
    await page.waitForTimeout(500);
    // Click the env card to enter env scope.
    await clickFlutterButton(page, envName ?? 'Staff');
    await waitForFlutterSemantics(page, 2_000);
    await page.waitForTimeout(1000);
    // Wait for the Auth sidebar item to appear (vertical services load async).
    await waitForFlutterText(page, 'Auth', 2_000);
    await page.waitForTimeout(500);
    // Now at env scope - Auth > Users is visible in the sidebar.
    await navigateViaSidebar(page, ['Auth', 'Users']);
  } else {
    await navigateViaSidebar(page, ['Auth', 'Users']);
  }
  await waitForFlutterSemantics(page, 2_000);
  await waitForFlutterText(page, 'Users', 2_000);
  await page.waitForTimeout(500);
  // Click "Create User" button (action link on the users list page).
  await clickFlutterButton(page, 'Create User');
  await page.waitForTimeout(500);
  // Fill the form fields in the order they appear in the admin UI:
  // First Name, Last Name, Email, Password, Status (default=active).
  await typeFlutterField(page, 'First Name', user.firstName);
  await page.waitForTimeout(100);
  await typeFlutterField(page, 'Last Name', user.lastName);
  await page.waitForTimeout(100);
  await typeFlutterField(page, 'Email', user.email);
  await page.waitForTimeout(100);
  await typeFlutterField(page, 'Password', user.password);
  await page.waitForTimeout(100);
  // Select groups via the autocomplete field if a group name is provided.
  if (user.group) {
    // Type the group name into the "Add to Groups" autocomplete field.
    await typeFlutterField(page, 'Add to Groups', user.group);
    await page.waitForTimeout(500);
    // Click the matching suggestion from the dropdown.
    await clickFlutterButton(page, user.group);
    await page.waitForTimeout(300);
  }
  // Click "Create User" to submit (the form's submit_label is "Create User").
  await clickFlutterButton(page, 'Create User');
  await page.waitForTimeout(1000);
}

/**
 * Add a user to a group via the Dash Auth8 admin UI.
 * Navigates to Auth8 → Groups, clicks on the target group, clicks
 * "Add Member", and enters the user's email.
 *
 * @param page       Playwright page
 * @param scope      'org' or 'env'
 * @param groupName  The group name (e.g. "app:eteller")
 * @param userEmail  The user's email to add as a member
 */
export async function addUserToGroupViaUI(
  page: Page,
  scope: 'org' | 'env',
  groupName: string,
  userEmail: string,
  envId?: string,
  envName?: string,
): Promise<void> {
  logStep(`[step] addUserToGroupViaUI: scope=${scope} group=${groupName} user=${userEmail}`);
  // Auth is env-scoped - navigate to the env's Auth > Groups via sidebar.
  if (scope === 'org' && envId) {
    // Navigate to org home, then click into the target env to enter env scope.
    await navigateViaSidebar(page, ['Organization']);
    await waitForFlutterSemantics(page, 2_000);
    await page.waitForTimeout(500);
    await clickFlutterButton(page, envName ?? 'Staff');
    await waitForFlutterSemantics(page, 2_000);
    await page.waitForTimeout(1000);
    // Wait for the Auth sidebar item to appear (vertical services load async).
    await waitForFlutterText(page, 'Auth', 2_000);
    await page.waitForTimeout(500);
    await navigateViaSidebar(page, ['Auth', 'Groups']);
  } else {
    await navigateViaSidebar(page, ['Auth', 'Groups']);
  }
  await waitForFlutterSemantics(page, 2_000);
  await waitForFlutterText(page, 'Groups', 2_000);
  await page.waitForTimeout(500);
  // Wait for the target group name to appear on the page.
  await waitForFlutterText(page, groupName, 2_000);
  await page.waitForTimeout(500);
  // The RFW data table renders groups as rows with "Name: {name}" text
  // and "Edit" buttons. Find the "Edit" button nearest to the group name.
  const editCoords = await page.evaluate((needle: string) => {
    const n = needle.toLowerCase();
    const els = Array.from(document.querySelectorAll('flt-semantics'));
    // Find the text element containing the group name.
    let nameRect: DOMRect | null = null;
    for (const el of els) {
      const t = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`.trim().toLowerCase();
      if (t.includes(n)) {
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.x > 0 || r.y > 0) { nameRect = r; break; }
      }
    }
    if (!nameRect) return null;
    const nameY = nameRect.y + nameRect.height / 2;
    // Find the nearest "Edit" button to the group name.
    let bestBtn: { x: number; y: number } | null = null;
    let bestDist = Infinity;
    for (const el of els) {
      const role = el.getAttribute('role');
      if (role !== 'button') continue;
      const t = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`.trim().toLowerCase();
      if (t !== 'edit') continue;
      const r = (el as HTMLElement).getBoundingClientRect();
      const btnY = r.y + (r.height > 0 ? r.height / 2 : 10);
      const btnX = r.x + (r.width > 0 ? r.width / 2 : 10);
      const dist = Math.abs(btnY - nameY);
      if (dist < bestDist && dist < 100) {
        bestDist = dist;
        bestBtn = { x: btnX, y: btnY };
      }
    }
    return bestBtn;
  }, groupName);
  if (editCoords) {
    await page.mouse.click(editCoords.x, editCoords.y);
    await page.waitForTimeout(1000);
  } else {
    throw new Error(`addUserToGroupViaUI: could not find "Edit" button for "${groupName}"`);
  }
  // The RFW group edit page has an "Assign Users" multiselect field.
  // Click the field to expand it, then click the user's email checkbox,
  // then click "Save Group".
  await waitForFlutterText(page, 'Assign Users', 2_000);
  await page.waitForTimeout(500);
  // Click "Assign Users" to expand the multiselect list.
  await clickFlutterButton(page, 'Assign Users');
  await page.waitForTimeout(500);
  // Click the user's email in the expanded multiselect list.
  await clickFlutterButton(page, userEmail);
  await page.waitForTimeout(500);
  // Click the "Save Group" submit button.
  await clickFlutterButton(page, 'Save Group');
  await page.waitForTimeout(2000);

  // Verify the save succeeded - check for error text on the page.
  const hasError = await page.evaluate(() => {
    const els = document.querySelectorAll('flt-semantics');
    for (const el of Array.from(els)) {
      const t = (el.textContent ?? '').toLowerCase();
      if (t.includes('error') || t.includes('failed') || t.includes('invalid') || t.includes('400')) {
        return true;
      }
    }
    return false;
  });
  if (hasError) {
    const errMsg = await page.evaluate(() => {
      const els = document.querySelectorAll('flt-semantics');
      for (const el of Array.from(els)) {
        const t = (el.textContent ?? '').toLowerCase();
        if (t.includes('error') || t.includes('failed') || t.includes('invalid') || t.includes('400')) {
          return el.textContent ?? '';
        }
      }
      return 'unknown error';
    });
    throw new Error(`addUserToGroupViaUI: save group "${groupName}" failed: ${errMsg}`);
  }
}

// ── App8 install via Dash App Store UI ──────────────────────────────

/**
 * Install an app from the Dash App Store through the browser UI.
 * Navigates to the App Store page, clicks "Install" on the specified
 * listing, fills the install dialog, and confirms.
 *
 * @param page         Playwright page
 * @param orgID        Organization ID
 * @param envID        Environment ID
 * @param listingName  The app_name of the listing to install (e.g. "eBank")
 * @param instanceName Optional instance name to type in the dialog
 * @returns The hostname of the created instance (extracted from the page)
 */
export async function installAppViaUI(
  page: Page,
  orgID: string,
  envID: string,
  listingName: string,
  instanceName?: string,
  subdomain?: string,
  authMode?: 'customer' | 'staff',
  staffAuthUrl?: string,
): Promise<string> {
  logStep(`[step] installAppViaUI: org=${orgID} env=${envID} listing=${listingName} instance=${instanceName ?? '(default)'} subdomain=${subdomain ?? '(default)'} authMode=${authMode ?? 'customer'}`);
  // Wait for the sidebar to be ready before navigating.
  await waitForFlutterSemantics(page, 4_000);
  await page.waitForTimeout(500);
  // Navigate to the App Store page via sidebar.
  await navigateViaSidebar(page, ['App', 'Store']);
  await waitForFlutterSemantics(page, 4_000);

  // Wait for the listing to appear.
  await waitForFlutterText(page, listingName, 4_000);
  // Give the listings grid time to fully render.
  await page.waitForTimeout(1000);

  // Click the "Install" button on the specific listing's card.
  // The store uses a GridView - each card has the app name text and an
  // Install IconButton. With multiple listings, there are multiple "Install"
  // buttons. We use the aria snapshot to find the Install button index that
  // corresponds to the target listing.
  //
  // The aria snapshot is a YAML-like string of the accessibility tree.
  // We parse it to find the listing name, then find the next "Install"
  // button after it (within the same card).
  let installBtnIndex = -1; // which Install button (0-indexed) to click
  try {
    const snapshot = await page.locator('flt-semantics').first().ariaSnapshot();
    // The snapshot is a YAML-like string. We parse it line by line to find
    // the listing name and the next Install button after it.
    const lines = snapshot.split('\n');
    let foundName = false;
    let installCount = 0;
    for (const line of lines) {
      const trimmed = line.trim();
      // Check if this line contains the listing name (as text content).
      if (!foundName && trimmed.includes(listingName)) {
        foundName = true;
        continue;
      }
      // After finding the listing name, look for the next Install button.
      if (foundName && trimmed.includes('button') && trimmed.includes('Install')) {
        installBtnIndex = installCount;
        break;
      }
      // Count all Install buttons we encounter before finding the name.
      if (trimmed.includes('button') && trimmed.includes('Install')) {
        installCount++;
      }
      // Stop if we hit another listing name (different card).
      if (foundName && trimmed && !trimmed.includes('button') && !trimmed.includes('Install') &&
          trimmed.length > 2 && trimmed.length < 30 && !trimmed.startsWith('-')) {
        // Could be another listing name - but we need to be careful.
        // Only break if it looks like a card name (not a description).
        // Actually, let's not break - the Install button should come
        // before the next card in tree order.
      }
    }
  } catch { /* ariaSnapshot might not work - fall through to coordinate-based */ }

  let installClicked = false;
  if (installBtnIndex >= 0) {
    // Click the correct Install button by index.
    try {
      const btns = await page.getByRole('button', { name: 'Install', exact: true }).all();
      if (installBtnIndex < btns.length) {
        await btns[installBtnIndex].click({ force: true });
        installClicked = true;
      }
    } catch { /* fall through */ }
  }
  if (!installClicked) {
    // Fallback: coordinate-based click using page.evaluate.
    const installCoords = await page.evaluate((needle: string) => {
      const n = needle.toLowerCase();
      const els = Array.from(document.querySelectorAll('flt-semantics'));
      let nameRect: DOMRect | null = null;
      for (const el of els) {
        const t = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`.trim().toLowerCase();
        if (t !== n) continue;
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.height > 60) continue;
        nameRect = r;
        break;
      }
      if (!nameRect) return null;
      let bestBtn: { x: number; y: number } | null = null;
      let bestDist = Infinity;
      for (const el of els) {
        const t = `${el.textContent ?? ''} ${el.getAttribute('aria-label') ?? ''}`.trim().toLowerCase();
        if (t !== 'install') continue;
        const role = el.getAttribute('role');
        if (role !== 'button') continue;
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        const btnCy = r.y + r.height / 2;
        const btnCx = r.x + r.width / 2;
        if (btnCy < nameRect.y) continue;
        if (btnCx < nameRect.x - 20 || btnCx > nameRect.x + 320) continue;
        const dist = btnCy - (nameRect.y + nameRect.height);
        if (dist < bestDist) {
          bestDist = dist;
          bestBtn = { x: btnCx, y: btnCy };
        }
      }
      return bestBtn;
    }, listingName);
    if (installCoords) {
      await page.mouse.click(installCoords.x, installCoords.y);
    } else {
      // Last resort: getByRole first Install button.
      try {
        const btn = page.getByRole('button', { name: 'Install', exact: true });
        if (await btn.count() > 0) {
          await btn.first().click({ force: true });
        }
      } catch { /* fall through */ }
    }
  }

  // Wait for the install dialog to render with its text fields.
  await waitForFlutterText(page, 'Subdomain', 2_000);

  // The Subdomain field is now REQUIRED and pre-filled with the app
  // slug (e.g. "ebank"). We only need to type into it if the test
  // supplied a different subdomain prefix (e.g. "www").
  if (subdomain) {
    await typeFlutterField(page, 'Subdomain', subdomain);
  }

  // Fill the install dialog if instance name is provided.
  if (instanceName) {
    await typeFlutterField(page, 'Instance Name (optional)', instanceName);
  }

  // Auth URL + Allow Sign-up - the install form has:
  // 1. "Auth URL" select dropdown (defaults to current env's auth)
  // 2. "Allow Sign-up" checkbox (defaults to checked = customer mode)
  //
  // For customer apps: auth_url defaults correctly, allow_signup is checked.
  // For staff apps: select the staff env's auth URL, uncheck allow_signup.
  if (authMode === 'staff' && staffAuthUrl) {
    // Select the staff auth URL from the dropdown.
    logStep(`[step] installAppViaUI: selecting auth URL: ${staffAuthUrl}`);
    await clickFlutterButton(page, 'Auth URL');
    await page.waitForTimeout(500);
    // The dropdown shows full URLs as options. Click the one matching staffAuthUrl.
    await clickFlutterButton(page, staffAuthUrl);
    await page.waitForTimeout(300);

    // Uncheck "Allow Sign-up" - staff apps have SSO only, no public sign-up.
    logStep(`[step] installAppViaUI: unchecking Allow Sign-up (staff mode)`);
    await clickFlutterCheckbox(page, 'Allow Sign-up');
    await page.waitForTimeout(300);
  }

  // Click the "Install" button in the dialog (a FilledButton, not IconButton).
  // Use getByRole - the dialog's Install FilledButton responds to getByRole clicks.
  try {
    const btn = page.getByRole('button', { name: 'Install', exact: true });
    const count = await btn.count();
    if (count > 0) {
      // The dialog's Install button is the last one rendered (after the
      // listing IconButtons). .last() targets it.
      try {
        await btn.last().click({ timeout: 2_000 });
      } catch {
        await btn.last().click({ force: true });
      }
    }
  } catch { /* fall through */ }

  // Check for error messages on the page after clicking Install.
  // The RFW form shows errors inline - don't silently move on if the
  // install failed. Only check short text elements to avoid false
  // positives from large container elements that concatenate all page text.
  await page.waitForTimeout(500);
  const installError = await page.evaluate(() => {
    const els = document.querySelectorAll('flt-semantics');
    for (const el of Array.from(els)) {
      const t = (el.textContent ?? '').trim();
      if (t.length > 200) continue; // Skip large container elements
      const lower = t.toLowerCase();
      if (lower.includes('error') || lower.includes('failed') || lower.includes('already exists') || lower.includes('409') || lower.includes('403') || lower.includes('forbidden')) {
        if (lower.includes('no error') || lower.includes('error-free')) continue;
        return t.substring(0, 200);
      }
    }
    return null;
  });
  if (installError) {
    throw new Error(`installAppViaUI: install failed for "${listingName}": ${installError}`);
  }

  // Wait for redirect to the Instances page - the install success
  // redirects to the instances list which shows the new instance.
  await waitForFlutterText(page, 'Instances', 2_000);

  // The hostname is deterministic: {subdomain}.{envSlug}.{orgDomain} when a
  // custom subdomain was supplied, else {appSlug}.{envSlug}.{orgDomain}.
  // The caller (test) owns the hostname value it persists to state - we
  // return '' because the dialog only sends the subdomain prefix and the
  // full hostname is assembled server-side.
  return '';
}

// ── RFW form helpers (E2E-UI-Full) ───────────────────────────────────

/** Extract the env_id from a Dash hash URL query string (e.g. `?env=xxx`). */
function envIdFromUrl(url: string): string | undefined {
  const queryIdx = url.indexOf('?env=');
  if (queryIdx < 0) return undefined;
  const val = url.substring(queryIdx + 5);
  const ampIdx = val.indexOf('&');
  return ampIdx >= 0 ? val.substring(0, ampIdx) : val;
}

/** Navigate to a Dash hash URL via the sidebar (like a human).
 *  Falls back to direct page.goto if sidebar navigation fails.
 */
async function navigateToDashHashUrl(page: Page, url: string): Promise<void> {
  try {
    const hashIdx = url.indexOf('#/');
    if (hashIdx >= 0) {
      const hashPath = url.substring(hashIdx + 2);
      const queryIdx = hashPath.indexOf('?');
      const pathPart = queryIdx >= 0 ? hashPath.substring(0, queryIdx) : hashPath;
      const segments = pathPart.split('/').filter((s) => s.length > 0);
      if (segments.length >= 2) {
        const service = segments[0];
        const route = segments.slice(1).join('/');
        const { navigateToDashPage } = await import('../tests/ui/_setup.js');
        await navigateToDashPage(page, service, route, undefined, envIdFromUrl(url));
        return;
      }
    }
  } catch { /* fall through to page.goto */ }
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForFlutterSemantics(page, 10_000);
  await waitForFlutterContent(page);
}

/**
 * Navigate to an RFW list page, click the "Create X" action button,
 * fill form fields, submit, and wait for redirect back to the list.
 *
 * @param page           Playwright page
 * @param listUrl        Full URL to the list page (e.g. `#/auth/roles?env=...`)
 * @param createLabel    Text on the create button (e.g. "Create Role")
 * @param fields         Array of {label, value} pairs for text fields
 * @param submitLabel    Text on the submit button (e.g. "Create Role")
 * @param selectFields   Optional array of {label, option} for dropdown selects
 */
export async function rfwCreateViaForm(
  page: Page,
  listUrl: string,
  createLabel: string,
  fields: { label: string; value: string }[],
  submitLabel: string,
  selectFields?: { label: string; option: string }[],
): Promise<void> {
  logStep(`[step] rfwCreateViaForm: ${createLabel} at ${listUrl}`);
  // Capture HTTP responses during form submission for fail-fast diagnostics.
  const allResponses: string[] = [];
  const httpErrors: string[] = [];
  const responseHandler = (resp: import('@playwright/test').Response) => {
    const url = resp.url();
    // Only log API calls (not static assets, fonts, etc.)
    if (url.includes('/proxy/') || url.includes('/v1/')) {
      allResponses.push(`${resp.status()} ${url.substring(url.indexOf('/proxy/'))}`);
    }
    if (resp.status() >= 400) {
      httpErrors.push(`${resp.status()} ${url}`);
    }
  };
  page.on('response', responseHandler);
  try {
    // Navigate to the list page via the sidebar (like a human).
    await navigateToDashHashUrl(page, listUrl);
    // Click the "Create X" action button - retry in case the RFW page
    // hasn't fully loaded the action button yet, AND re-verify the form
    // actually opened (the Flutter web a11y tree can be stale - a click on
    // a stale element's boundingBox is swallowed without navigating, leaving
    // the helper typing into a page with no fields - incident 2026-09-09).
    const firstFieldLabel = fields[0]?.label ?? '';
    let clickOk = false;
    for (let attempt = 0; attempt < 5 && !clickOk; attempt++) {
      try {
        await clickFlutterButton(page, createLabel);
      } catch {
        await page.waitForTimeout(500);
        continue;
      }
      // Wait for the create form to actually appear.
      await page.waitForTimeout(2000);
      await waitForFlutterSemantics(page, 10_000);
      // Flutter web headless renders text fields as real <input>/<textarea>
      // elements carrying aria-label (the flt-semantics tree only exposes
      // role="textbox" for FOCUSED fields - never rely on it for presence).
      const formVisible = await page.evaluate((label) => {
        const n = label.toLowerCase();
        for (const el of Array.from(document.querySelectorAll('input, textarea'))) {
          const aria = (el.getAttribute('aria-label') ?? '').toLowerCase();
          if (aria === n || aria.includes(n)) return true;
        }
        return false;
      }, firstFieldLabel);
      if (formVisible) {
        clickOk = true;
      } else {
        // Re-navigate to the list (the stale click may have left the app in
        // an odd state) and retry the click.
        await navigateToDashHashUrl(page, listUrl).catch(() => {});
        await page.waitForTimeout(500);
      }
    }
    await waitForFlutterContent(page);
    await page.waitForTimeout(1000);
    // Fill text fields.
    for (const field of fields) {
      await typeFlutterField(page, field.label, field.value);
      await page.waitForTimeout(100);
      // Tab out of the field to trigger Flutter form validation.
      await page.keyboard.press('Tab');
      await page.waitForTimeout(50);
    }
    // Select dropdown fields (click the field, then click the option).
    if (selectFields) {
      for (const sel of selectFields) {
        await clickFlutterButton(page, sel.label);
        await page.waitForTimeout(200);
        await clickFlutterButton(page, sel.option);
        await page.waitForTimeout(200);
      }
    }
    // Submit the form - retry in case the submit button wasn't enabled yet.
    const submitDeadline = Date.now() + 3_000;
    while (Date.now() < submitDeadline) {
      try {
        await clickFlutterButton(page, submitLabel, true);
        break;
      } catch {
        await page.waitForTimeout(200);
      }
    }
    await page.waitForTimeout(1000);

    // FAIL FAST: check for HTTP errors during form submission.
    // Retry on 502 (upstream temporarily unavailable - service restart race).
    // A retried submit can log an earlier 4xx before a successful one (the
    // submit loop clicks again when the first click fires before fields are
    // validated) - only fail when NO response in the flow ultimately
    // succeeded (2xx/3xx).
    const is502 = httpErrors.some(e => e.startsWith('502'));
    const is502Only = is502 && httpErrors.every(e => e.startsWith('502'));
    // allResponses entries are "<status> <path>" - success = 2xx/3xx status prefix.
    const anySuccess = allResponses.some(r => /^(20[0-9]|30[0-9]) /.test(r));
    if (httpErrors.length > 0 && !is502Only && !anySuccess) {
      const texts = await getFlutterTexts(page);
      throw new Error(
        `rfwCreateViaForm: HTTP errors during form submission:\n  ${httpErrors.join('\n  ')}\n` +
        `All API responses: ${allResponses.join(', ')}\n` +
        `Visible texts: ${texts.slice(0, 20).join(' | ')}`
      );
    }
    if (httpErrors.length > 0 && anySuccess) {
      // A 2xx/3xx response exists - the submission ultimately succeeded.
      logStep(`[step] rfwCreateViaForm: ${httpErrors.length} transient HTTP error(s) superseded by a successful response`);
    }

    // FAIL FAST: if no API calls were made at all, the form didn't submit.
    if (allResponses.length === 0) {
      const texts = await getFlutterTexts(page);
      throw new Error(
        `rfwCreateViaForm: no API calls detected - form submission likely failed.\n` +
        `Submit label used: "${submitLabel}"\n` +
        `Visible texts: ${texts.slice(0, 20).join(' | ')}`
      );
    }

    // Log all API responses for debugging (even on success).
    logStep(`[step] rfwCreateViaForm: API responses: ${allResponses.join(', ') || '(none)'}`);

    // FAIL FAST: check for error messages in the Flutter UI after form submit.
    // The RFW renderer shows errors as text with icons like error_outline.
    const texts = await getFlutterTexts(page);
    const errorTexts = texts.filter(t =>
      t.toLowerCase().includes('error') ||
      t.toLowerCase().includes('failed') ||
      t.toLowerCase().includes('invalid') ||
      t.toLowerCase().includes('forbidden') ||
      t.toLowerCase().includes('missing') ||
      t.toLowerCase().includes('rejected')
    );
    if (errorTexts.length > 0) {
      throw new Error(
        `rfwCreateViaForm: form submission failed with error(s):\n  ${errorTexts.join('\n  ')}\n` +
        `All visible texts: ${texts.slice(0, 20).join(' | ')}`
      );
    }
  } finally {
    page.off('response', responseHandler);
  }
}

/**
 * Navigate to an RFW list page and verify that the given text appears
 * in the rendered content.
 * FAIL FAST: if the item is not found, logs all visible texts and throws.
 */
export async function rfwVerifyInList(
  page: Page,
  listUrl: string,
  textToFind: string,
  timeout = 5_000,
): Promise<boolean> {
  logStep(`[step] rfwVerifyInList: looking for "${textToFind}" at ${listUrl}`);
  await navigateToDashHashUrl(page, listUrl);
  try {
    await waitForFlutterText(page, textToFind, timeout);
    return true;
  } catch {
    // FAIL FAST: log what IS on the page so the error is actionable.
    const texts = await getFlutterTexts(page);
    throw new Error(
      `rfwVerifyInList: "${textToFind}" not found at ${listUrl}.\n` +
      `Visible texts (${texts.length}): ${texts.slice(0, 30).join(' | ')}`
    );
  }
}

/**
 * Navigate to an RFW list page, find a row containing the identifier text,
 * and click the row action button on that row.
 */
export async function rfwRowAction(
  page: Page,
  listUrl: string,
  rowIdentifier: string,
  actionLabel: string,
): Promise<void> {
  logStep(`[step] rfwRowAction: ${actionLabel} on row containing "${rowIdentifier}" at ${listUrl}`);
  await navigateToDashHashUrl(page, listUrl);
  await waitForFlutterText(page, rowIdentifier, 5_000);
  // Click the action button INSIDE the row card that contains the identifier.
  // The RFW DataTable renders each row as a Card whose subtree holds the row
  // text AND its action buttons; a page-wide `clickFlutterButton(actionLabel)`
  // clicks the FIRST matching button in the a11y tree - which can belong to a
  // different row (incident 2026-09-09: page-wide "Delete" hit the
  // scope-mirror row while the test asserted the tenant row was removed).
  // CanvasKit paints row text on the CANVAS - the card's textContent only
  // carries the button labels; the row fields live in the card group's
  // aria-label, so the container match must read BOTH.
  const locate = ({ needle, action }: { needle: string; action: string }) =>
    page.evaluate(({ needle, action }: { needle: string; action: string }) => {
    const n = needle.toLowerCase();
    const a = action.toLowerCase();
    const els = Array.from(document.querySelectorAll('flt-semantics'));
    // Candidate row cards: the SMALLEST element whose text contains the row
    // identifier AND an action button label. Page-level containers also carry
    // every row's text in their aria-label - walking all candidates and
    // picking the smallest matching subtree prevents an ancestor match from
    // clicking another row's button (the a11y tree lists rows in render
    // order; an ancestor hit clicks the FIRST row's action).
    let best: Element | null = null;
    for (const el of els) {
      const t = `${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''}`.toLowerCase();
      if (!t.includes(n) || !t.includes(a)) continue;
      if (!best || best.contains(el)) best = el; // keep the deepest candidate
    }
    if (!best) return null;
    // Within the smallest card's subtree, find the action button.
    // (Array.from: NodeListOf predates the DOM.Iterable iteration
    // protocols this tsconfig's lib set targets - an explicit spread
    // keeps the for-of valid under every lib combination.)
    for (const btn of Array.from(best.querySelectorAll('flt-semantics'))) {
      const bt = `${btn.textContent ?? ''} ${btn.getAttribute('aria-label') ?? ''}`.trim().toLowerCase();
      if (bt !== a || btn.getAttribute('role') !== 'button') continue;
      const r0 = (btn as HTMLElement).getBoundingClientRect();
      if (r0.width === 0 && r0.height === 0) continue;
      // Scroll the button into view BEFORE reading coordinates: the target
      // card can sit outside the viewport after navigation (the list keeps
      // the previous scroll offset), and mouse.click at off-screen
      // coordinates hits whichever visible row lies under those pixels.
      (btn as HTMLElement).scrollIntoView({ block: 'center' });
      const r = (btn as HTMLElement).getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }
    return null;
  }, { needle: rowIdentifier, action: actionLabel });
  // Poll: the a11y tree renders row text before the action buttons appear;
  // an immediate single probe can miss the button and would previously fall
  // back to a page-wide click that can target a DIFFERENT row's action.
  let clicked: { x: number; y: number } | null = null;
  for (let attempt = 0; attempt < 20 && !clicked; attempt++) {
    clicked = await locate({ needle: rowIdentifier, action: actionLabel });
    if (!clicked) await page.waitForTimeout(500);
  }
  if (!clicked) {
    throw new Error(
      `rfwRowAction: no visible row card contains "${rowIdentifier}" with an ` +
      `${actionLabel} button after 10s - refusing a page-wide click that can ` +
      `target a different row.`,
    );
  }
  // The a11y tree can re-render between the rect read and the mouse click,
  // silently swallowing the activation (observed: a Revoke click that never
  // reached the network). Verify the click actually fired a non-GET request;
  // re-locate and re-click when it did not. The row-action endpoints are
  // idempotent (UPDATE status / DELETE), so a re-fire is safe.
  for (let attempt = 0; attempt < 3; attempt++) {
    const postPromise = page
      .waitForRequest(
        (req) =>
          req.method() !== 'GET' && req.resourceType() === 'fetch',
        { timeout: 3_000 },
      )
      .then(() => true)
      .catch(() => false);
    await page.mouse.click(clicked.x, clicked.y);
    const fired = await postPromise;
    if (fired) break;
    clicked = await locate({ needle: rowIdentifier, action: actionLabel });
    if (!clicked) {
      throw new Error(
        `rfwRowAction: row "${rowIdentifier}" action "${actionLabel}" button ` +
        `disappeared after a swallowed click.`,
      );
    }
  }
  await page.waitForTimeout(500);
}

// ── Re-exports for convenience ────────────────────────────────────────
export { URLs, bff8AppURL, app8RuntimeURL };
export type { Persona, E2EState };
export { updateState, loadState };
