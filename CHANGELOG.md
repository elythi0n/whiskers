# Changelog

## 0.4.0

- Sends usage-limit readings to Pawprints when it is installed, so `pawprints ui` can chart the 5 hour and weekly limits over time. A "Send limits to Pawprints" setting turns it off.

## 0.3.1

- Separate setting for the chart bars, so the token pace and its warnings can stay without them.

## 0.3.0

- Token chart 🧶: tokens per minute over the last 8 minutes.
- Burn rate next to usage limits: how fast the 5 hour limit fills, and when it would be full.
- The chart turns 🔥 when the limit would fill before it resets, 🙀 when within the hour.
- Show or hide each part of the line in /config.
- Context fill now updates during a long prompt, not only when it ends.

## 0.2.1

- Drop the extra dot between the hint line and the whiskers line.

## 0.2.0

- The line now sits at the end of the hint line under the prompt, with no notice prefix.
- New Position setting in /config: below (default) or above the prompt.
- Above, it's drawn in your theme's colours, with usage and context yellow past 80% and red past 90%.

## 0.1.0

- First version: model, effort, usage limits, and context in the status line.
- Files and lines +/− for the current prompt when Pawprints is installed.
