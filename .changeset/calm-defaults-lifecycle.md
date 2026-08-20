---
"pi-keep-defaults": patch
---

Make runtime and file guarding session-scoped and reload-safe, restore native setter delegation after shutdown, validate patch descriptors transactionally, cancel pending restores, and safely fall back with warnings when Pi's internal SettingsManager setters are incompatible.
