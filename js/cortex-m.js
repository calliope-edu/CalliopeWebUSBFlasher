// DAPLink partial-flash helpers using the dapjs library.
// Mirrors MakeCode's DAPWrapper (pxt-calliope/editor/flash.ts) as closely as
// possible.  The dapjs library is loaded from js/dapjs.js (the same bundle
// used by pxt-calliope / pxt-microbit).
'use strict';

// ---------------------------------------------------------------------------
// ARM Thumb machine code blobs — copied verbatim from
// https://github.com/microsoft/pxt-microbit/blob/master/editor/flash.ts
// ---------------------------------------------------------------------------

// void flashPage(uint32_t targetAddr, uint32_t *dataInRAM, uint32_t pageWords)
const flashPageBIN = new Uint32Array([
    0xbe00be00, // two BKPT #0; LR is set to first BKPT so core halts on return
    0x2502b5f0, 0x4c204b1f, 0xf3bf511d, 0xf3bf8f6f, 0x25808f4f, 0x002e00ed,
    0x2f00595f, 0x25a1d0fc, 0x515800ed, 0x2d00599d, 0x2500d0fc, 0xf3bf511d,
    0xf3bf8f6f, 0x25808f4f, 0x002e00ed, 0x2f00595f, 0x2501d0fc, 0xf3bf511d,
    0xf3bf8f6f, 0x599d8f4f, 0xd0fc2d00, 0x25002680, 0x00f60092, 0xd1094295,
    0x511a2200, 0x8f6ff3bf, 0x8f4ff3bf, 0x2a00599a, 0xbdf0d0fc, 0x5147594f,
    0x2f00599f, 0x3504d0fc, 0x46c0e7ec, 0x4001e000, 0x00000504,
]);

// void computeHashes(uint32_t *dst, uint8_t *flashBase, uint32_t pageSize, uint32_t numPages)
const computeChecksums2 = new Uint32Array([
    0x4c27b5f0, 0x44a52680, 0x22009201, 0x91004f25, 0x00769303, 0x24080013,
    0x25010019, 0x40eb4029, 0xd0002900, 0x3c01407b, 0xd1f52c00, 0x468c0091,
    0xa9044665, 0x506b3201, 0xd1eb42b2, 0x089b9b01, 0x23139302, 0x9b03469c,
    0xd104429c, 0x2000be2a, 0x449d4b15, 0x9f00bdf0, 0x4d149e02, 0x49154a14,
    0x3e01cf08, 0x2111434b, 0x491341cb, 0x405a434b, 0x4663405d, 0x230541da,
    0x4b10435a, 0x466318d2, 0x230541dd, 0x4b0d435d, 0x2e0018ed, 0x6002d1e7,
    0x9a009b01, 0x18d36045, 0x93003008, 0xe7d23401, 0xfffffbec, 0xedb88320,
    0x00000414, 0x1ec3a6c8, 0x2f9be6cc, 0xcc9e2d51, 0x1b873593, 0xe6546b64,
]);

// RAM layout (mirrors MakeCode constants exactly)
const CM_LOAD_ADDR  = 0x20000000; // where ARM code blobs are uploaded
const CM_DATA_ADDR  = 0x20002000; // checksum output / page-data staging area
const CM_STACK_ADDR = 0x20001000; // stack pointer for ARM code blobs

// ---------------------------------------------------------------------------
// murmur3 hash (mirrors MakeCode's murmur3_core in flash.ts exactly)
// ---------------------------------------------------------------------------
function murmur3_core(data) {
    let h0 = 0x2F9BE6CC;
    let h1 = 0x1EC3A6C8;
    for (let i = 0; i < data.length; i += 4) {
        let k = (data[i] | (data[i+1] << 8) | (data[i+2] << 16) | (data[i+3] << 24)) >>> 0;
        k = Math.imul(k, 0xcc9e2d51) >>> 0;
        k = ((k << 15) | (k >>> 17)) >>> 0;
        k = Math.imul(k, 0x1b873593) >>> 0;
        h0 = (h0 ^ k) >>> 0;
        h1 = (h1 ^ k) >>> 0;
        h0 = ((h0 << 13) | (h0 >>> 19)) >>> 0;
        h1 = ((h1 << 13) | (h1 >>> 19)) >>> 0;
        h0 = (Math.imul(h0, 5) + 0xe6546b64) >>> 0;
        h1 = (Math.imul(h1, 5) + 0xe6546b64) >>> 0;
    }
    return [h0, h1];
}

// ---------------------------------------------------------------------------
// onlyChangedPages (mirrors DAPWrapper.onlyChanged in flash.ts exactly)
// checksums is a Uint8Array: 8 bytes per page = [h0 LE u32, h1 LE u32]
// pageBlocks: [{address:number, data:Uint8Array(pageSize)}]
// ---------------------------------------------------------------------------
function onlyChangedPages(pageBlocks, checksums, pageSize) {
    return pageBlocks.filter(block => {
        const idx = block.address / pageSize;
        if ((idx | 0) !== idx) return true;                   // misaligned → must write
        if (idx * 8 + 8 > checksums.length) return true;     // out of range → must write
        const base = idx * 8;
        const c0 = (checksums[base]   | (checksums[base+1] << 8) | (checksums[base+2] << 16) | (checksums[base+3] << 24)) >>> 0;
        const c1 = (checksums[base+4] | (checksums[base+5] << 8) | (checksums[base+6] << 16) | (checksums[base+7] << 24)) >>> 0;
        const [h0, h1] = murmur3_core(block.data);
        return c0 !== h0 || c1 !== h1;
    });
}

// ---------------------------------------------------------------------------
// DAPFlasher — wraps dapjs exactly as MakeCode's DAPWrapper does.
// Must be constructed AFTER the USB device is already open and claimed.
// ---------------------------------------------------------------------------
class DAPFlasher {
    /**
     * @param {WebUSBDevice} usbDevice  already-connected WebUSBDevice instance
     */
    constructor(usbDevice) {
        this.usb = usbDevice;
        this.pageSize = 1024;
        this.numPages = 256;

        // Wire our USB send/receive into dapjs — mirrors DAPWrapper.allocDAP()
        this._dap = new DapJS.DAP({
            write: (data) => this.usb.sendPacket(new Uint8Array(data)),
            close: () => Promise.resolve(),
            read:  () => this.usb.receivePacket(5000),
        });
        this._cortexM = new DapJS.CortexM(this._dap);
    }

    // -----------------------------------------------------------------------
    // Flush stale USB packets from previous sessions.
    // Mirrors DAPWrapper.clearCommandsAsync() — sends 5 DAP_Info requests
    // and discards responses to clear any leftover data in the USB pipeline.
    // -----------------------------------------------------------------------
    async clearCommands() {
        log('DAPFlasher: reconnecting USB to clear pending transfers...');
        await this.usb.reconnect();

        log('DAPFlasher: flushing stale USB packets...');
        for (let i = 0; i < 5; i++) {
            try {
                // DAP_Info (id=0x00, info=0x04 = firmware version)
                await this.usb.sendPacket(new Uint8Array([0x00, 0x04]));
                await this.usb.receivePacket(200);
            } catch (e) { /* expected */ }
        }
        log('DAPFlasher: USB pipeline flushed');
    }

    // -----------------------------------------------------------------------
    // Initialise, halt, reset (halt=true), and read FICR.
    // skipFlush=true: skip clearCommands() — used for J-Link OB devices which
    // do not respond to the speculative DAP_Info probes (they have no stale
    // pending transfers from previous DAPLink sessions).
    // -----------------------------------------------------------------------
    async init(skipFlush = false) {
        if (!skipFlush) {
            await this.clearCommands();
        } else {
            log('DAPFlasher: skipping USB flush (J-Link device)');
        }

        log('DAPFlasher: cortexM.init()...');
        await this._cortexM.init();

        log('DAPFlasher: cortexM.reset(halt=true)...');
        await this._cortexM.reset(true);

        // readPageSize: read FICR CODEPAGESIZE + CODESIZE at 0x10000010
        log('DAPFlasher: reading FICR page info...');
        const ficr = await this._cortexM.memory.readBlock(0x10000010, 2, this.pageSize);
        const v = new Uint32Array(ficr.buffer);
        if (v[0] === 1024 || v[0] === 4096) this.pageSize = v[0];
        if (v[1] > 0 && v[1] <= 1024)       this.numPages = v[1];
        log(`DAPFlasher: pageSize=${this.pageSize}, numPages=${this.numPages}`);
    }

    // -----------------------------------------------------------------------
    // Read UICR CLENR0 — mirrors DAPWrapper.readUICR()
    // Returns the low byte of the 32-bit value at 0x10001014.
    // 0x00 = never set (safe for partial flash)
    // 0xFF = erased (safe for partial flash — nRF51/Calliope mini typical)
    // Other = code-region lock → need full erase → full flash
    // -----------------------------------------------------------------------
    async readUICR() {
        const u8 = await this._cortexM.memory.readBlock(0x10001014, 1, this.pageSize);
        const v = new Uint32Array(u8.buffer);
        const uicr = v[0] & 0xFF;
        log(`DAPFlasher: UICR=0x${uicr.toString(16)} (raw=0x${v[0].toString(16).padStart(8, '0')})`);
        return uicr;
    }

    // -----------------------------------------------------------------------
    // Run computeChecksums2 on the device CPU to hash all flash pages.
    // Returns Uint8Array: numPages × 8 bytes = [h0_u32_LE, h1_u32_LE] per page.
    // Mirrors DAPWrapper.getFlashChecksumsAsync().
    //
    // computeChecksums2 exits via POP {r4-r7,pc} which restores PC from the
    // saved LR.  We set LR=0xffffffff so that return causes a HardFault.
    // To make the core halt on HardFault (rather than spin in the handler) we
    // set DEMCR.VC_HARDERR (bit 10) before resuming → hardfault = debug halt.
    // -----------------------------------------------------------------------
    async getFlashChecksums() {
        const pages = this.numPages;
        log(`DAPFlasher: running checksum blob on device (${pages} pages × ${this.pageSize} B)`);

        // Enable vector-catch on HardFault so LR=0xffffffff return halts the core
        const DEMCR = 0xE000EDFC;
        const VC_HARDERR = 1 << 10;
        const demcr = await this._cortexM.memory.read32(DEMCR);
        await this._cortexM.memory.write32(DEMCR, demcr | VC_HARDERR);
        log(`DAPFlasher: DEMCR set to 0x${(demcr | VC_HARDERR).toString(16)} (VC_HARDERR enabled)`);

        try {
            await this._cortexM.runCode(
                computeChecksums2,
                CM_LOAD_ADDR,       // address: where to write the code blob
                CM_LOAD_ADDR + 1,   // pc:      entry point (Thumb bit set)
                0xffffffff,         // lr:      return to here → HardFault → halt
                CM_STACK_ADDR,      // sp
                true,               // upload=true: write code blob to RAM first
                CM_DATA_ADDR,       // R0: output buffer address
                0,                  // R1: flash base (0x00000000)
                this.pageSize,      // R2: page size in bytes
                pages               // R3: number of pages
            );
        } finally {
            // Restore DEMCR (clear VC_HARDERR)
            await this._cortexM.memory.write32(DEMCR, demcr);
            log(`DAPFlasher: DEMCR restored to 0x${demcr.toString(16)}`);
        }

        const result = await this._cortexM.memory.readBlock(CM_DATA_ADDR, pages * 2, this.pageSize);
        log(`DAPFlasher: received ${result.length} checksum bytes`);
        return result;
    }

    // -----------------------------------------------------------------------
    // Flash only the changed pages using flashPageBIN.
    // Mirrors DAPWrapper.quickHidFlashAsync().
    // -----------------------------------------------------------------------
    async quickFlashPages(changedPages, progressCallback) {
        const pageSize = this.pageSize;
        log(`DAPFlasher: quick flash — writing ${changedPages.length} page(s)`);

        // Write the flashPageBIN stub to RAM once (it stays there for all pages)
        await this._cortexM.memory.writeBlock(CM_LOAD_ADDR, flashPageBIN);

        for (let i = 0; i < changedPages.length; i++) {
            const b = changedPages[i];

            if (b.address >= 0x10000000) {
                log(`DAPFlasher: skipping out-of-range page 0x${b.address.toString(16)}`);
                continue;
            }

            log(`DAPFlasher: writing page ${i + 1}/${changedPages.length} at 0x${b.address.toString(16)}`);

            // Alternate between two staging buffers (MakeCode double-buffering pattern)
            const thisAddr = (i & 1) ? CM_DATA_ADDR             : CM_DATA_ADDR + pageSize;
            const nextAddr = (i & 1) ? CM_DATA_ADDR + pageSize  : CM_DATA_ADDR;

            if (i === 0) {
                // First iteration: write page data; subsequent ones are pre-fetched below
                const u32 = new Uint32Array(b.data.buffer, b.data.byteOffset, pageSize / 4);
                await this._cortexM.memory.writeBlock(thisAddr, u32);
            }

            // Set registers and start flashPageBIN — mirrors DAPWrapper.runFlash()
            // flashPageBIN starts with two BKPT halfwords (4 bytes); real code at +4.
            const cmd = this._cortexM.prepareCommand();
            cmd.halt();
            cmd.writeCoreRegister(15 /* PC */, CM_LOAD_ADDR + 4 + 1); // +4 skips BKPTs, +1 = Thumb
            cmd.writeCoreRegister(14 /* LR */, CM_LOAD_ADDR + 1);     // return → BKPT → halt
            cmd.writeCoreRegister(13 /* SP */, CM_STACK_ADDR);
            cmd.writeCoreRegister(0, b.address);       // R0 = target flash address
            cmd.writeCoreRegister(1, thisAddr);         // R1 = data buffer in RAM
            cmd.writeCoreRegister(2, pageSize >> 2);   // R2 = page size in words
            await cmd.go();
            await this._cortexM.debug.enable();        // un-halts and starts debug

            // While current page is flashing, pre-fetch the next page into the other buffer
            const next = changedPages[i + 1];
            if (next) {
                const buf = new Uint32Array(next.data.buffer, next.data.byteOffset, pageSize / 4);
                await this._cortexM.memory.writeBlock(nextAddr, buf);
            }

            await this._cortexM.waitForHalt(500);
            if (progressCallback) progressCallback((i + 1) / changedPages.length);
        }

        log('DAPFlasher: quick flash done, resetting device...');
        await this._cortexM.reset(false);
    }
}
