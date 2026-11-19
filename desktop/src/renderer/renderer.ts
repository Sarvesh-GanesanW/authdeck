import { grantBanner, type GrantRowView } from '../shared/envView';
import { showsPairing, usableDevices, type ActivityItem, type CliPathState, type DesktopApi, type DeviceView, type ViewState } from '../shared/state';
import { backgroundPlace, clockTime, cliPathView, lastSeen, outcomeView, statusOf, timeLeft, type OutcomeView } from './format';
import { ICONS, type IconName } from './icons';

declare global {
  interface Window {
    authdeck: DesktopApi;
  }
}

const api = window.authdeck;
const COPIED_FEEDBACK_MS = 1500;
const COUNTDOWN_TICK_MS = 1000;
/** Shown in the PIN slots and the address while pairing is closed: nothing secret, nothing stale. */
const CLOSED_PIN = '------';
const SVG_NS = 'http://www.w3.org/2000/svg';

type Child = Node | string;

interface Props {
  class?: string;
  attrs?: Record<string, string>;
  onClick?: (event: Event) => void;
}

function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, children: Child[] = []): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (props.class) element.className = props.class;
  for (const [name, value] of Object.entries(props.attrs ?? {})) element.setAttribute(name, value);
  if (props.onClick) element.addEventListener('click', props.onClick);
  element.append(...children);
  return element;
}

function icon(name: IconName, size = 24): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

function raised(child: Node, className = ''): HTMLDivElement {
  return h('div', { class: `raised ${className}`.trim() }, [child]);
}

/** Stable id so keyboard focus survives a re-render. */
function key<T extends HTMLElement>(element: T, focusKey: string): T {
  element.dataset.focusKey = focusKey;
  return element;
}

function button(label: Child[], props: Props & { focusKey: string }): HTMLButtonElement {
  return key(h('button', { ...props, class: `vbtn c1 ${props.class ?? ''}`.trim(), attrs: { type: 'button', ...props.attrs } }, label), props.focusKey);
}

let latest: ViewState | null = null;
let copiedUntil = 0;

function renderHeader(state: ViewState): void {
  const status = statusOf({ agent: state.agent, pairedDevices: usableDevices(state), needsAccessibility: state.needsAccessibility });
  document.getElementById('status-lamp')!.className = `lamp ${status.tone}`;
  document.getElementById('status-text')!.textContent = status.text;
  document.getElementById('back-slot')!.hidden = !(showsPairing(state) && usableDevices(state) > 0);
}

function pinCaps(pin: string | null): HTMLDivElement {
  const caps = [...(pin ?? CLOSED_PIN)].map((digit) => h('span', { class: 'cap c1' }, [digit]));
  const half = Math.ceil(caps.length / 2);
  const children = [...caps.slice(0, half).map((cap) => raised(cap)), h('span', { class: 'gap' }), ...caps.slice(half).map((cap) => raised(cap))];
  const label = pin ? `PIN ${pin.slice(0, 3)} ${pin.slice(3)}` : 'No PIN: pairing is closed';
  return h('div', { class: 'pin', attrs: { role: 'group', 'aria-label': label } }, children);
}

/** The QR code, or an empty square of the same size while pairing is closed. */
function qrCode(computerName: string, size: number, path: string): HTMLElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${size} ${size}`);
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', path ? `Pairing QR code for ${computerName}` : 'No QR code: pairing is closed');
  svg.setAttribute('shape-rendering', 'crispEdges');
  const dark = document.createElementNS(SVG_NS, 'path');
  dark.setAttribute('d', path);
  svg.append(dark);
  return h('figure', { class: 'raised' }, [h('div', { class: 'qr c2' }, [svg])]);
}

/** "Pairing open for 9:59", kept current by the countdown tick without redrawing the view. */
function pairingClock(closesAt: number | null): string {
  return closesAt === null ? 'Pairing is closed. Open it again to show a new PIN and QR code.' : `Pairing open for ${timeLeft(closesAt, Date.now())}`;
}

function pairView(state: ViewState): Child[] {
  if (state.agent.state !== 'running') return [];
  const { hosts, port, pairing, keyWords } = state.agent;
  const address = hosts.length > 0 ? `${hosts[0]}:${port}` : 'Connect this computer to Wi-Fi or Ethernet';
  const copied = Date.now() < copiedUntil;
  const copy = button([icon(copied ? 'check' : 'copy')], {
    class: 'sq',
    focusKey: 'copy',
    attrs: { 'aria-label': copied ? 'Address copied' : 'Copy address' },
    onClick: () => {
      api.copyAddress();
      copiedUntil = Date.now() + COPIED_FEEDBACK_MS;
      render();
      setTimeout(render, COPIED_FEEDBACK_MS);
    },
  });
  copy.disabled = hosts.length === 0;
  const text = h('section', { class: 'pair-text' }, [
    h('h2', {}, ['Pair your tablet or phone']),
    ...repairNote(state),
    h('p', {}, ['Open AuthDeck on it and scan this code.']),
    h('p', {}, [`Or pick ${state.computerName} in the app and type this PIN:`]),
    pinCaps(pairing?.pin ?? null),
    h('p', { class: 'key-words', attrs: { id: 'pairing-clock', role: 'timer', 'aria-live': 'off' } }, [pairingClock(pairing?.closesAt ?? null)]),
    h('p', { class: 'key-words' }, [
      'Key words ',
      // Six words in two lines of three, so they fit the pairing column.
      h('strong', {}, [keyWords.slice(0, 3).join(' · ')]),
      h('br', {}, []),
      h('strong', {}, [keyWords.slice(3).join(' · ')]),
      h('span', {}, [`. After pairing, the app shows the same words for ${state.computerName}.`]),
    ]),
    h('div', { class: 'address-row' }, [
      h('div', { class: 'field c1', attrs: { 'aria-label': 'Address' } }, [address]),
      raised(copy),
      raised(button([icon('refresh'), pairing ? 'New PIN' : 'Open pairing'], { focusKey: 'new-pin', onClick: () => api.openPairing() })),
    ]),
  ]);
  const qr = pairing?.qr ?? { size: 29, path: '' };
  return [h('div', { class: 'pair well c2' }, [qrCode(state.computerName, qr.size, qr.path), text])];
}

/** Shown while devices paired before the update still need to pair again. */
function repairNote(state: ViewState): Child[] {
  const waiting = state.devices.filter((device) => device.needsRepair).map((device) => device.deviceName);
  if (waiting.length === 0) return [];
  return [h('p', { class: 'repair-note' }, [`AuthDeck now encrypts the connection, so ${waiting.join(', ')} must pair once more. Keys and pages stay on the device.`])];
}

function deviceState(device: DeviceView): HTMLElement {
  if (device.needsRepair) {
    return h('span', { class: 'device-state', attrs: { title: 'AuthDeck now encrypts the connection. Pair this device again from the app.' } }, [h('span', { class: 'lamp warn' }), 'Must pair again']);
  }
  const lamp = h('span', { class: `lamp ${device.connected ? 'ok' : ''}`.trim() });
  if (device.connected) return h('span', { class: 'device-state' }, [lamp, 'Connected']);
  const seen = lastSeen(device.lastSeenAt);
  return h('span', { class: 'device-state', attrs: { title: seen.full } }, [lamp, seen.short]);
}

function deviceCard(device: DeviceView): HTMLElement {
  const state = deviceState(device);
  return raised(
    h('div', { class: 'device c1' }, [
      h('span', { class: 'tile c1', attrs: { 'aria-hidden': 'true' } }, [icon(device.form === 'phone' ? 'phone' : 'tablet')]),
      h('div', { class: 'device-text' }, [
        h('span', { class: 'device-name', attrs: { title: device.deviceName } }, [device.deviceName]),
        state,
      ]),
      button([icon('unlink')], {
        class: 'sq small quiet',
        focusKey: `unpair-${device.deviceId}`,
        attrs: { 'aria-label': `Unpair ${device.deviceName}`, title: 'Unpair' },
        onClick: () => api.unpair(device.deviceId),
      }),
    ]),
  );
}

function activityOutcome(item: ActivityItem): OutcomeView {
  return item.kind === 'action' ? outcomeView(item.outcome) : item.outcome;
}

/** Env rows carry a key before the title, as in the design. */
function activityRow(item: ActivityItem): HTMLLIElement {
  const outcome = activityOutcome(item);
  const result = h('span', { class: `result ${outcome.tone === 'bad' ? 'bad' : ''}`.trim(), attrs: { title: outcome.explanation ?? outcome.text } }, [
    h('span', { class: `lamp ${outcome.tone}` }),
    h('span', {}, [outcome.text]),
  ]);
  const title: Child[] = item.kind === 'env' ? [icon('key', 16), h('span', {}, [item.title])] : [item.title];
  return h('li', { class: 'row' }, [
    h('span', { class: 'time' }, [clockTime(item.at)]),
    h('span', { class: 'what' }, [
      h('span', { class: `what-title ${item.kind === 'env' ? 'env' : ''}`.trim(), attrs: { title: item.title } }, title),
      h('span', { class: 'what-detail', attrs: { title: item.detail } }, [item.detail]),
    ]),
    result,
  ]);
}

/** "9:12 left", kept current by the countdown tick without redrawing the view. */
function grantClock(endsAt: number): HTMLSpanElement {
  const clock = h('span', { class: 'grant-left', attrs: { role: 'timer', 'aria-live': 'off' } }, [grantLeft(endsAt)]);
  clock.dataset.endsAt = String(endsAt);
  return clock;
}

function grantLeft(endsAt: number): string {
  return `${timeLeft(endsAt, Date.now())} left`;
}

function endNowButton(grantId: string, setName: string, compact: boolean): HTMLElement {
  return raised(
    button(['End now'], {
      class: compact ? 'compact' : '',
      focusKey: `end-grant-${grantId}`,
      attrs: { 'aria-label': `End now: ${setName}` },
      onClick: () => api.endGrant(grantId),
    }),
  );
}

function grantRow(row: GrantRowView): HTMLLIElement {
  return h('li', { class: 'grant-row' }, [
    h('span', { class: 'what' }, [
      h('span', { class: 'what-title', attrs: { title: row.title } }, [row.title]),
      h('span', { class: 'what-detail', attrs: { title: row.detail } }, [row.detail]),
    ]),
    grantClock(row.endsAt),
    endNowButton(row.grantId, row.setName, true),
  ]);
}

/** While a grant is open: which set, which device, the time left, and End now (End all with several). */
function grantBannerView(state: ViewState): Child[] {
  const view = grantBanner(state.grants, Date.now(), clockTime);
  if (!view) return [];
  const keyIcon = h('span', { class: 'grant-icon' }, [icon('key', 36)]);
  if (view.kind === 'one') {
    return [
      h('div', { class: 'raised', attrs: { role: 'status', 'aria-label': 'Open env grant' } }, [
        h('div', { class: 'banner c2' }, [
          keyIcon,
          h('div', { class: 'banner-text' }, [h('h2', {}, [view.title]), h('p', {}, [`${view.detail} `, grantClock(view.endsAt), '.'])]),
          endNowButton(view.grantId, view.setName, false),
        ]),
      ]),
    ];
  }
  const endAll = raised(button(['End all'], { focusKey: 'end-all-grants', onClick: () => api.endAllGrants() }));
  return [
    h('div', { class: 'raised', attrs: { role: 'status', 'aria-label': 'Open env grants' } }, [
      h('div', { class: 'banner grants c2' }, [
        h('div', { class: 'grants-head' }, [keyIcon, h('h2', {}, [view.title]), endAll]),
        h('ol', { class: 'grant-list' }, view.rows.map(grantRow)),
      ]),
    ]),
  ];
}

function accessibilityBanner(): HTMLElement {
  return h('div', { class: 'raised', attrs: { role: 'alert' } }, [
    h('div', { class: 'banner c2' }, [
      icon('alert', 36),
      h('div', { class: 'banner-text' }, [
        h('h2', {}, ['Turn on Accessibility for AuthDeck Agent']),
        h('p', {}, ['macOS blocks key presses and typed text until you allow it. Opening apps, links and commands still works.']),
      ]),
      raised(button(['Open System Settings', icon('external')], { class: 'primary', focusKey: 'open-settings', onClick: () => api.openAccessibilitySettings() })),
    ]),
  ]);
}

function pairedView(state: ViewState): Child[] {
  const devices = h('section', { class: 'devices well c2', attrs: { 'aria-labelledby': 'devices-title' } }, [
    h('h2', { class: 'panel-title', attrs: { id: 'devices-title' } }, ['Devices']),
    h('div', { class: 'device-list' }, state.devices.map(deviceCard)),
    raised(button([icon('plus'), 'Pair another device'], { focusKey: 'pair-another', onClick: () => api.setPairingRequested(true) }), 'add'),
  ]);
  const list =
    state.activity.length > 0
      ? h('ol', {}, state.activity.map(activityRow))
      : h('p', { class: 'empty' }, ['Nothing yet. Press a key on your device and it shows up here.']);
  const activity = h('section', { class: 'activity well c2', attrs: { 'aria-labelledby': 'activity-title' } }, [
    h('div', { class: 'activity-head' }, [h('h2', { class: 'panel-title', attrs: { id: 'activity-title' } }, ['Activity']), h('span', {}, ['What your devices ran, newest first'])]),
    list,
  ]);
  const panels = h('div', { class: 'panels' }, [devices, activity]);
  return [...(state.needsAccessibility ? [accessibilityBanner()] : []), ...grantBannerView(state), panels];
}

function noticeView(title: string, body: string, retry: boolean): Child[] {
  const children: Child[] = [icon('alert', 36), h('h2', {}, [title]), h('p', {}, [body])];
  if (retry) children.push(raised(button(['Try again'], { focusKey: 'retry', onClick: () => api.retryStart() })));
  return [h('div', { class: 'notice well c2' }, [h('div', { class: 'notice-body' }, children)])];
}

function mainView(state: ViewState): Child[] {
  const { agent } = state;
  switch (agent.state) {
    case 'starting':
      return [h('div', { class: 'notice well c2' }, [h('p', { class: 'empty' }, ['Starting the agent…'])])];
    case 'port-in-use':
      return noticeView(
        `Port ${agent.port} is already in use`,
        'Another AuthDeck agent is probably running on this computer, for example the command-line agent started from a terminal. Quit it, then try again.',
        true,
      );
    case 'failed':
      return noticeView('The agent could not start', agent.message, true);
    case 'running':
      return showsPairing(state) ? pairView(state) : pairedView(state);
  }
}

function footer(state: ViewState): Child[] {
  const toggle = key(
    h('button', {
      class: 'track c1',
      attrs: { type: 'button', role: 'switch', 'aria-checked': String(state.startAtSignIn), 'aria-labelledby': 'start-at-sign-in' },
      onClick: () => api.setStartAtSignIn(!state.startAtSignIn),
    }, [h('span', { class: 'knob c1' })]),
    'start-at-sign-in',
  );
  const children: Child[] = [toggle, h('span', { attrs: { id: 'start-at-sign-in' } }, ['Start when I sign in'])];
  if (showsPairing(state)) {
    children.push(h('span', { class: 'note' }, [`Closing this window keeps the agent running in ${backgroundPlace(state.platform)}.`]));
    return children;
  }
  const runner = state.commandRunner;
  if (runner && state.agent.state === 'running') {
    const currentLabel = runner.choices.find((choice) => choice.value === runner.current)?.label ?? runner.current;
    const picker = button([currentLabel, icon('chevronDown')], {
      class: 'picker quiet',
      focusKey: 'runner',
      // The label beside it hides in a narrow window.
      attrs: { id: 'runner', 'aria-haspopup': 'menu', title: `Run commands in ${currentLabel}` },
      onClick: (event) => {
        const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
        api.chooseCommandRunner({ left: rect.left, bottom: rect.bottom + 4 });
      },
    });
    children.push(h('label', { class: 'runner-label', attrs: { for: 'runner' } }, ['Run commands in']), raised(picker));
  }
  if (state.cliPath && state.agent.state === 'running') children.push(cliPathControl(state.cliPath));
  children.push(h('span', { class: 'note', attrs: { title: `Version ${state.version}` } }, [h('span', { class: 'version-word' }, ['Version ']), state.version]));
  return children;
}

/** "authdeck command ● on your PATH", as in the design; it opens the menu to put it there or remove it. */
function cliPathControl(cliPath: CliPathState): HTMLElement {
  const view = cliPathView(cliPath);
  const control = button([h('code', {}, ['authdeck']), h('span', { class: `lamp ${view.tone}` }), h('span', { class: 'cli-state' }, [view.text]), icon('chevronDown')], {
    class: 'picker quiet cli-path',
    focusKey: 'cli-path',
    attrs: { 'aria-haspopup': 'menu', 'aria-label': `authdeck command: ${view.text}`, title: view.title },
    onClick: (event) => {
      const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
      api.chooseCliPath({ left: rect.left, bottom: rect.bottom + 4 });
    },
  });
  return raised(control);
}

function render(): void {
  if (!latest) return;
  const focused = (document.activeElement as HTMLElement | null)?.dataset.focusKey;
  document.getElementById('app')!.dataset.platform = latest.platform;
  renderHeader(latest);
  document.getElementById('view')!.replaceChildren(...mainView(latest));
  document.getElementById('footer')!.replaceChildren(...footer(latest));
  if (focused) document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focused)}"]`)?.focus();
}

document.getElementById('back')!.addEventListener('click', () => api.setPairingRequested(false));
setInterval(() => {
  const clock = document.getElementById('pairing-clock');
  if (clock && latest?.agent.state === 'running') clock.textContent = pairingClock(latest.agent.pairing?.closesAt ?? null);
  for (const grant of document.querySelectorAll<HTMLElement>('[data-ends-at]')) grant.textContent = grantLeft(Number(grant.dataset.endsAt));
}, COUNTDOWN_TICK_MS);
api.onState((state) => {
  latest = state;
  render();
});
