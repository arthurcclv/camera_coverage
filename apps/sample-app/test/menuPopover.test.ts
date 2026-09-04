import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { popoverSide, MENU_WIDTH_PX } from '../src/ui/menuPopover.ts';

test('popoverSide: opens outward, to the right (spec §5.5)', () => {
  // Both hierarchy popovers open away from the panel. That overhangs `.left-panel`,
  // which is why they are `position: fixed` — its `overflow: hidden` clipped an
  // absolutely positioned child to a sliver at the panel edge.
  assert.equal(popoverSide(320, MENU_WIDTH_PX, 1440), 'right');
});

test('popoverSide: flips inward when opening outward would leave the window', () => {
  // A wide left panel (the divider is draggable) is what makes this reachable.
  assert.equal(popoverSide(1380, MENU_WIDTH_PX, 1440), 'left');
});

test('popoverSide: a popover ending exactly at the window edge still opens outward', () => {
  // Fitting is not overflowing — flipping here would move the popover for nothing.
  assert.equal(popoverSide(1280, 160, 1440), 'right');
  assert.equal(popoverSide(1281, 160, 1440), 'left');
});

test('popoverSide: a narrow window flips even a left-hand anchor', () => {
  assert.equal(popoverSide(300, 160, 380), 'left');
});

test('MENU_WIDTH_PX matches the width index.css gives the hierarchy popovers', () => {
  // The side is decided before the popover renders, so this constant stands in for a
  // measurement. If the stylesheet's width changes and this doesn't, every flip
  // decision is made against the wrong number — silently, and only near the edge.
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  const rule = css.match(
    /\.add-menu-anchor \.menu,\s*\.menu\.context-menu,\s*\.menu\.submenu \{[^}]*?width:\s*(\d+)px/,
  );
  assert.ok(rule, 'the shared hierarchy-popover rule should declare a fixed width');
  assert.equal(Number(rule[1]), MENU_WIDTH_PX);
});

test('the hierarchy popovers are fixed-positioned, not absolute', () => {
  // Absolute positioning is what `.left-panel`'s `overflow: hidden` clips.
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  const rule = css.match(/\.add-menu-anchor \.menu,\s*\.menu\.context-menu,\s*\.menu\.submenu \{([^}]*)\}/);
  assert.ok(rule);
  assert.match(rule[1], /position:\s*fixed/);
});
