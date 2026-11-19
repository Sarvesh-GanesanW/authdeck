// qrcode-terminal ships its QR encoder without types; this is the part banner.ts uses.
declare module 'qrcode-terminal/vendor/QRCode' {
  export default class QRCode {
    constructor(typeNumber: number, errorCorrectLevel: number);
    addData(data: string): void;
    make(): void;
    getModuleCount(): number;
    isDark(row: number, col: number): boolean;
  }
}

declare module 'qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel' {
  const levels: { L: number; M: number; Q: number; H: number };
  export default levels;
}
