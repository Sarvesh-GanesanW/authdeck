/**
 * Colorways: every colour the app draws with.
 * Keys pick one of five block tones; the rest of the UI uses the surface and block tokens.
 */

export type CapColor = 'alpha' | 'mod' | 'a' | 'b' | 'c';
export const CAP_COLORS: CapColor[] = ['alpha', 'mod', 'a', 'b', 'c'];

export interface CapTone {
  /** Swatch name shown to the user (e.g. "Amber"). */
  name: string;
  /** Lit top and left edge of the block. */
  hi: string;
  /** Top face, main colour. */
  top: string;
  /** Shaded right edge, and the line where the top meets the front face. */
  shade: string;
  /** Front face, where the sublegend is printed. */
  front: string;
  /** Icon and label colour on the top surface. */
  legend: string;
  /** Sublegend colour on the skirt. */
  sub: string;
}

/** A neutral voxel block: lit edge, top face, shaded edge, front face. */
export interface BlockTone {
  hi: string;
  top: string;
  shade: string;
  front: string;
}

export type ColorwayId = 'graphite' | 'paper' | 'tide';

export interface Colorway {
  id: ColorwayId;
  name: string;
  about: string;
  dark: boolean;
  /** App background (the deck's case). */
  case: string;
  /** Recessed area the keys sit in. */
  plate: string;
  /** Empty socket in edit mode. */
  socket: string;
  socketStem: string;
  /** Panels, sheets, dialogs. */
  surface: string;
  /** Raised blocks inside a panel. */
  surfaceAlt: string;
  /** Text inputs. */
  field: string;
  line: string;
  text: string;
  textDim: string;
  textFaint: string;
  ok: string;
  run: string;
  danger: string;
  /** Text on the danger colour, and danger text on surfaces. */
  dangerText: string;
  scrim: string;
  /** Selection ring and links. */
  focus: string;
  /** Hard drop shadow under raised blocks (never blurred). */
  shadow: string;
  /** Dark lip along the top of sunken areas: plate, sockets, fields, grooves. */
  lip: string;
  /** Neutral raised controls: header buttons, secondary buttons, chips. */
  control: BlockTone;
  /** Things floating above the deck: banners and menus. */
  float: BlockTone;
  caps: Record<CapColor, CapTone>;
}

const graphite: Colorway = {
  id: 'graphite',
  name: 'Graphite',
  about: 'Dark and calm next to a monitor.',
  dark: true,
  case: '#22262E',
  plate: '#191C22',
  socket: '#14161B',
  socketStem: '#4B515D',
  surface: '#2A2E37',
  surfaceAlt: '#22262E',
  field: '#1D2027',
  line: 'rgba(255,255,255,0.09)',
  text: '#F0EADC',
  textDim: '#A9B1BF',
  textFaint: '#7F8898',
  ok: '#62E3A0',
  run: '#FFC857',
  danger: '#FF6B5E',
  dangerText: '#FF9B8A',
  scrim: 'rgba(10,12,16,0.62)',
  focus: '#E8AD44',
  shadow: 'rgba(0,0,0,0.32)',
  lip: 'rgba(0,0,0,0.38)',
  control: { hi: '#3A404C', top: '#2E333D', shade: '#272B33', front: '#1F2329' },
  float: { hi: '#454B59', top: '#343A46', shade: '#2D323D', front: '#262A33' },
  caps: {
    alpha: { name: 'Graphite', hi: '#535C6E', top: '#434A58', shade: '#3A404C', front: '#2B3039', legend: '#F0EADC', sub: '#A9B1BF' },
    mod: { name: 'Charcoal', hi: '#3E4451', top: '#30353F', shade: '#2A2E37', front: '#1F2329', legend: '#CBD1DB', sub: '#949DAC' },
    a: { name: 'Amber', hi: '#F6C976', top: '#E8AD44', shade: '#D09833', front: '#A87425', legend: '#2A1C07', sub: '#1A1103' },
    b: { name: 'Teal', hi: '#7ACFBD', top: '#5CB7A3', shade: '#4CA18E', front: '#3F8E7D', legend: '#0B231E', sub: '#04120E' },
    c: { name: 'Iris', hi: '#B8B9F5', top: '#9C9DE9', shade: '#8A8BD9', front: '#7778C6', legend: '#16173A', sub: '#0B0C24' },
  },
};

const paper: Colorway = {
  id: 'paper',
  name: 'Paper',
  about: 'Light blocks for bright rooms.',
  dark: false,
  case: '#D9D3C5',
  plate: '#C6BFAE',
  socket: '#B8B09E',
  socketStem: '#958D7C',
  surface: '#EAE5DA',
  surfaceAlt: '#DED8CB',
  field: '#F6F2EA',
  line: 'rgba(40,36,28,0.12)',
  text: '#2B2925',
  textDim: '#5E594F',
  textFaint: '#7A7468',
  ok: '#1E9E5A',
  run: '#D08F14',
  danger: '#C0392B',
  dangerText: '#A93226',
  scrim: 'rgba(40,36,28,0.38)',
  focus: '#C9483A',
  shadow: 'rgba(70,58,36,0.24)',
  lip: 'rgba(70,58,36,0.18)',
  control: { hi: '#FFFDF7', top: '#ECE7DC', shade: '#DCD6C9', front: '#BDB5A3' },
  float: { hi: '#FFFFFF', top: '#FBF8F2', shade: '#ECE7DC', front: '#CFC8B8' },
  caps: {
    alpha: { name: 'Paper', hi: '#FFFDF7', top: '#F1ECE1', shade: '#E2DCCF', front: '#CFC7B6', legend: '#2B2925', sub: '#4A463E' },
    mod: { name: 'Stone', hi: '#CBC5B6', top: '#B9B2A3', shade: '#ABA494', front: '#958D7C', legend: '#26241F', sub: '#2E2B25' },
    a: { name: 'Red', hi: '#DE6C5D', top: '#C9483A', shade: '#B53E31', front: '#8F2E23', legend: '#FFF4EC', sub: '#FFE6DA' },
    b: { name: 'Navy', hi: '#4778A6', top: '#2F5D8A', shade: '#29527A', front: '#1E3F5F', legend: '#F2F5FA', sub: '#E3EAF3' },
    c: { name: 'Olive', hi: '#93B271', top: '#7A9A5A', shade: '#6C8A4F', front: '#4F6838', legend: '#F5F8EF', sub: '#EEF3E6' },
  },
};

const tide: Colorway = {
  id: 'tide',
  name: 'Tide',
  about: 'White blocks on deep teal.',
  dark: true,
  case: '#1D2B33',
  plate: '#142027',
  socket: '#0F191F',
  socketStem: '#3F5664',
  surface: '#24353F',
  surfaceAlt: '#1D2B33',
  field: '#172630',
  line: 'rgba(255,255,255,0.09)',
  text: '#EAF1F3',
  textDim: '#A3B5BD',
  textFaint: '#7D919A',
  ok: '#62E3A0',
  run: '#FFC857',
  danger: '#FF6B5E',
  dangerText: '#FF9B8A',
  scrim: 'rgba(6,14,18,0.62)',
  focus: '#58C4DD',
  shadow: 'rgba(0,0,0,0.32)',
  lip: 'rgba(0,0,0,0.38)',
  control: { hi: '#3A5260', top: '#2A3D47', shade: '#23343D', front: '#1A2930' },
  float: { hi: '#46606D', top: '#30474F', shade: '#293D46', front: '#203038' },
  caps: {
    alpha: { name: 'Foam', hi: '#FFFFFF', top: '#E6ECEE', shade: '#D3DCDF', front: '#AFBEC4', legend: '#1A2830', sub: '#23343D' },
    mod: { name: 'Slate', hi: '#4E6A79', top: '#3C5563', shade: '#344B58', front: '#263843', legend: '#DCE6EA', sub: '#B7C7CE' },
    a: { name: 'Lagoon', hi: '#7ED8EC', top: '#58C4DD', shade: '#48B1CA', front: '#2F8BA2', legend: '#08232B', sub: '#04171D' },
    b: { name: 'Sun', hi: '#FAE39A', top: '#F2D06B', shade: '#E0BD58', front: '#B8963A', legend: '#2A2306', sub: '#201A03' },
    c: { name: 'Rose', hi: '#F2B0C3', top: '#E58FA8', shade: '#D37E97', front: '#B25E77', legend: '#2E0F19', sub: '#22070F' },
  },
};

export const COLORWAYS: Record<ColorwayId, Colorway> = { graphite, paper, tide };
export const COLORWAY_LIST: Colorway[] = [graphite, paper, tide];
