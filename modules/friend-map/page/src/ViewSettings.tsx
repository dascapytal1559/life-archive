// The open view's settings (viewSettings.ts), in a section of the menu at
// the top left (ViewSwitcher.tsx) set apart by a line above and below, under
// "<view> settings": first, on a page that shows names, the name choice
// (NamesSetting, NamesMenu.tsx), with a dot beside the title while No name
// except… is on, then the view's own, each group of them set apart by a line
// (the name choice in the first); nothing for a page with none. A choice between a few is
// a row of toggle buttons, the one on pressed; a theme colour is the same row
// of its presets, each with its swatch, then Custom, whose swatch opens the
// colour picker; a range is a slider with its value beside it, a percentage
// unless the setting says. The heading is a button that folds the
// section away or opens it, closed to start and kept per browser, one choice
// for every view.

import { useId } from "react";
import { demoMode } from "./demoMode.ts";
import { keptSetting, useStore } from "./keptSetting.ts";
import { useNameStyle } from "./names.ts";
import { NamesSetting } from "./NamesMenu.tsx";
import { groupsOf, type ColourSetting, type SliderSetting, type ToggleSetting, type ViewSetting } from "./viewSettings.ts";

export const SETTINGS_OPEN_KEY = "friend-map.viewSettings.open";
/** Whether the settings section is open, for every view alike; closed until opened. */
export const settingsOpenStore = keptSetting(SETTINGS_OPEN_KEY, false, (kept) => kept === "true");

export function ViewSettings({ slug, title, names = false, demo = demoMode }: {
  slug: string;
  title: string;
  /** Whether the page shows names, so its settings open with the name choice. */
  names?: boolean;
  demo?: boolean;
}) {
  const groups = groupsOf(slug);
  const open = useStore(settingsOpenStore);
  const style = useNameStyle();
  const id = useId();
  if (groups.length === 0 && !names) return null;
  return (
    <section className="view-switcher__settings" aria-label={`${title} settings`}>
      <button type="button" className="view-switcher__group view-switcher__fold" aria-expanded={open} aria-controls={id} onClick={() => settingsOpenStore.set(!open)}>
        <span className="view-switcher__caret" aria-hidden />
        {title} settings
        {names && style === "except" && <span className="view-switcher__dot" role="img" aria-label="No name except… is on" title="No name except… is on" />}
      </button>
      {open && (
        <div className="view-switcher__setting-list" id={id}>
          {(groups.length > 0 ? groups : [[]]).map((group, i) => (
            <div key={i} className="view-switcher__setting-group">
              {i === 0 && names && <NamesSetting demo={demo} />}
              {group.map((setting) => <Setting key={setting.label} setting={setting} />)}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Setting({ setting }: { setting: ViewSetting }) {
  const id = useId();
  return (
    <div className="view-switcher__setting">
      <span className="view-switcher__label" id={id}>{setting.label}</span>
      {setting.kind === "toggle" ? <Toggle setting={setting} labelledBy={id} /> : setting.kind === "colour" ? <Colour setting={setting} labelledBy={id} /> : <Slider setting={setting} />}
    </div>
  );
}

/** A choice between a few as one row of buttons, the one on pressed; Name format (NamesMenu.tsx) draws its own with it. */
export function Toggle({ setting, labelledBy }: { setting: ToggleSetting<unknown>; labelledBy: string }) {
  const value = useStore(setting.store);
  return (
    <div className="view-switcher__toggle" data-wrap={setting.wrap || undefined} role="group" aria-labelledby={labelledBy}>
      {setting.choices.map((choice) => (
        <button key={choice.title} type="button" aria-pressed={Object.is(choice.value, value)} title={choice.about} onClick={() => setting.store.set(choice.value)}>
          {choice.title}
        </button>
      ))}
    </div>
  );
}

function Colour({ setting, labelledBy }: { setting: ColourSetting<string>; labelledBy: string }) {
  const value = useStore(setting.store);
  const last = useStore(setting.custom);
  const custom = !setting.presets.some((preset) => preset.value === value);
  const pick = (colour: string) => {
    setting.custom.set(colour as typeof last);
    setting.store.set(colour as typeof last);
  };
  return (
    <div className="view-switcher__toggle" role="group" aria-labelledby={labelledBy}>
      {setting.presets.map((preset) => (
        <button key={preset.title} type="button" aria-pressed={preset.value === value} title={preset.about} onClick={() => setting.store.set(preset.value)}>
          <span className="view-switcher__swatch" style={{ background: preset.swatch }} aria-hidden />
          {preset.title}
        </button>
      ))}
      {/* Custom: a click puts the last custom colour back and opens the picker on it; each colour picked is taken at once. */}
      <label className="view-switcher__custom" data-on={custom || undefined} title="Any colour: the whole look is worked out from it" onClick={() => !custom && setting.store.set(last)}>
        <input type="color" aria-label={`Custom ${setting.label.toLowerCase()}${custom ? ", chosen" : ""}`} value={custom ? value : last} onChange={(event) => pick(event.target.value)} />
        Custom
      </label>
    </div>
  );
}

function Slider({ setting }: { setting: SliderSetting }) {
  const value = useStore(setting.store);
  const shown = setting.format ? setting.format(value) : `${Math.round(((value - setting.min) / (setting.max - setting.min)) * 100)}%`;
  return (
    <label className="view-switcher__slider">
      <input
        type="range"
        min={setting.min}
        max={setting.max}
        step={setting.step}
        value={value}
        aria-label={setting.label}
        aria-valuetext={shown}
        onChange={(event) => setting.store.set(Number(event.target.value))}
      />
      <output>{shown}</output>
    </label>
  );
}
