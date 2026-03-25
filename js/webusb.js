// WebUSB device connection handler - Extracted and adapted from MakeCode

// USB device filters for Calliope mini
const USB_FILTERS = [
    // Standard DAPLink CMSIS-DAP
    { vendorId: 0x0D28, productId: 0x0204, classCode: 0xff, subclassCode: 0x03 },
    { vendorId: 0x0D28, productId: 0x0204, classCode: 0xff, subclassCode: 0x00 },
    // Segger J-Link (Calliope mini 2.x)
    { vendorId: 0x1366, productId: 0x1015 }, // Mini 2.0
    { vendorId: 0x1366, productId: 0x1025 }, // Mini 2.1
    { vendorId: 0x1366 } // Generic Segger
];

class WebUSBDevice {
    constructor() {
        this.device = null;
        this.interface = null;
        this.endpoint = { in: null, out: null };
        this.connected = false;
        this.onConnectionChanged = null;
        this.onDeviceAppeared = null;
    }

    /**
     * Request device selection from user
     */
    async requestDevice() {
        try {
            log('Requesting USB device...');
            this.device = await navigator.usb.requestDevice({
                filters: USB_FILTERS
            });
            
            if (this.device) {
                log(`Device selected: ${this.device.productName} (${this.device.manufacturerName})`);
                return true;
            }
            return false;
        } catch (error) {
            if (error.name === 'NotFoundError') {
                log('User cancelled device selection');
                return false;
            }
            throw error;
        }
    }

    /**
     * Connect to the device
     */
    async connect() {
        if (!this.device) {
            throw new Error('No device selected. Call requestDevice() first.');
        }

        try {
            log('Opening device...');
            await this.device.open();
            
            log('Selecting configuration...');
            await this.device.selectConfiguration(1);
            
            // Find the appropriate interface
            const iface = this.findInterface();
            if (!iface) {
                throw new Error('Could not find compatible USB interface');
            }
            
            this.interface = iface;
            log(`Claiming interface ${iface.interfaceNumber}...`);
            try {
                await this.device.claimInterface(iface.interfaceNumber);
            } catch (e) {
                if (e.message.includes('protected class')) {
                    throw new Error('Cannot claim USB interface - it is protected. Try disconnecting and reconnecting the device, or use a different USB port.');
                }
                throw e;
            }
            
            // Find endpoints
            const altIface = iface.alternates[0];
            if (altIface.endpoints.length > 0) {
                for (const ep of altIface.endpoints) {
                    if (ep.direction === 'in' && ep.packetSize === 64) {
                        this.endpoint.in = ep.endpointNumber;
                    } else if (ep.direction === 'out' && ep.packetSize === 64) {
                        this.endpoint.out = ep.endpointNumber;
                    }
                }
                log(`Using bulk endpoints: IN=${this.endpoint.in}, OUT=${this.endpoint.out}`);
            } else {
                log('Using control transfer (no bulk endpoints)');
            }
            
            this.connected = true;
            if (this.onConnectionChanged) {
                this.onConnectionChanged(true);
            }
            
            log('Device connected successfully');
            return true;
        } catch (error) {
            log(`Connection error: ${error.message}`);
            await this.disconnect();
            throw error;
        }
    }

    /**
     * Find compatible USB interface
     */
    findInterface() {
        if (!this.device || !this.device.configurations) return null;
        
        // Protected interface classes that cannot be claimed
        const protectedClasses = [0x01, 0x02, 0x03, 0x08, 0x0A, 0x0B, 0x0E, 0x10];

        // ── J-Link OB (Calliope mini 2.x) ──────────────────────────────────────────
        // Interface 2 (vendor class 0xFF/0xFF/0xFF) is the J-Link command interface.
        // It accepts SEGGER's J-Link MSD protocol (0xED, 0x1C …).
        // Endpoints vary by hardware revision:
        //   v2.0: EP 3 IN / EP 2 OUT
        //   v2.1: EP 5 IN / EP 4 OUT
        // (detected dynamically from the interface descriptor)
        if (this.device.vendorId === 0x1366) {
            for (const config of this.device.configurations) {
                for (const iface of config.interfaces) {
                    const alt = iface.alternates[0];
                    log(`Interface ${iface.interfaceNumber}: class=${alt.interfaceClass}, subclass=${alt.interfaceSubclass}, protocol=${alt.interfaceProtocol}, endpoints=${alt.endpoints.length}`);
                    if (alt.interfaceClass === 0xFF && alt.interfaceSubclass === 0xFF &&
                        alt.endpoints.length === 2 &&
                        alt.endpoints.every(e => e.type === 'bulk')) {
                        log(`  J-Link: selecting vendor interface ${iface.interfaceNumber} (J-Link MSD protocol)`);
                        return iface;
                    }
                }
            }
            log('J-Link: vendor interface not found');
            return null;
        }
        // ─────────────────────────────────────────────────────────────────────────────

        let candidates = [];
        
        for (const config of this.device.configurations) {
            for (const iface of config.interfaces) {
                const alt = iface.alternates[0];
                
                log(`Interface ${iface.interfaceNumber}: class=${alt.interfaceClass}, subclass=${alt.interfaceSubclass}, protocol=${alt.interfaceProtocol}, endpoints=${alt.endpoints.length}`);
                
                // Skip protected interface classes
                if (protectedClasses.includes(alt.interfaceClass)) {
                    log(`  Skipping protected interface class ${alt.interfaceClass}`);
                    continue;
                }
                
                // Match against filters
                for (const filter of USB_FILTERS) {
                    const vendorMatch = filter.vendorId === this.device.vendorId;
                    const productMatch = !filter.productId || filter.productId === this.device.productId;
                    const classMatch = !filter.classCode || alt.interfaceClass === filter.classCode;
                    const subclassMatch = !filter.subclassCode || alt.interfaceSubclass === filter.subclassCode;
                    
                    if (vendorMatch && productMatch && classMatch && subclassMatch) {
                        // Check endpoints - should be either 0 (control) or 2 bulk endpoints
                        if (alt.endpoints.length === 0 ||
                            (alt.endpoints.length === 2 && 
                             alt.endpoints.every(e => e.packetSize === 64))) {
                            log(`  Found candidate interface ${iface.interfaceNumber}`);
                            
                            // Priority: bulk endpoints > vendor-specific class > others
                            let priority = 0;
                            if (alt.endpoints.length === 2) priority += 10; // Strongly prefer bulk endpoints
                            if (alt.interfaceClass === 0xFF) priority += 1; // Prefer vendor-specific
                            
                            candidates.push({
                                iface: iface,
                                priority: priority
                            });
                        }
                    }
                }
            }
        }
        
        if (candidates.length === 0) {
            log('No compatible interfaces found');
            return null;
        }
        
        // Sort by priority and return the best one
        candidates.sort((a, b) => b.priority - a.priority);
        log(`Selected interface ${candidates[0].iface.interfaceNumber}`);
        return candidates[0].iface;
    }

    /**
     * Send a raw J-Link protocol command and optionally receive a response.
     * Unlike sendPacket(), this does NOT pad to 64 bytes and supports large
     * payloads (4KB MSD image chunks). Used exclusively for J-Link MSD flashing.
     */
    async sendJLinkCommand(cmd, expectResponse = true) {
        if (!this.connected) throw new Error('Device not connected');
        const result = await this.device.transferOut(this.endpoint.out, cmd);
        if (result.status !== 'ok') throw new Error(`J-Link send failed: ${result.status}`);
        if (!expectResponse) return new Uint8Array(0);
        const resp = await this.device.transferIn(this.endpoint.in, 64);
        if (resp.status !== 'ok') throw new Error(`J-Link receive failed: ${resp.status}`);
        return new Uint8Array(resp.data.buffer, resp.data.byteOffset, resp.data.byteLength);
    }

    /**
     * Full close → 500 ms delay → reopen, mirroring MakeCode's reconnectAsync.
     * Cancels all pending USB transfers and resets the CMSIS-DAP session.
     */
    async reconnect() {
        log('Reconnecting USB device (close → wait → open)...');
        try {
            if (this.device) await this.device.close();
        } catch (e) { /* ignore */ }
        await delay(500);
        try {
            await this.device.open();
            await this.device.selectConfiguration(1);
            await this.device.claimInterface(this.interface.interfaceNumber);
            log('USB device reconnected successfully');
        } catch (e) {
            log(`Reconnect error: ${e.message}`);
            throw e;
        }
    }

    /**
     * Disconnect from device
     */
    async disconnect() {
        if (this.device && this.connected) {
            try {
                log('Disconnecting device...');
                if (this.interface) {
                    await this.device.releaseInterface(this.interface.interfaceNumber);
                }
                await this.device.close();
            } catch (error) {
                log(`Disconnect error: ${error.message}`);
            }
        }
        
        this.device = null;
        this.interface = null;
        this.endpoint = { in: null, out: null };
        this.connected = false;
        
        if (this.onConnectionChanged) {
            this.onConnectionChanged(false);
        }
    }

    /**
     * Send packet to device
     */
    async sendPacket(data) {
        if (!this.connected) {
            throw new Error('Device not connected');
        }

        const packet = new Uint8Array(64);
        packet.fill(0);
        packet.set(data.slice(0, 64));

        log(`Sending packet [${Array.from(packet.slice(0, 8)).map(b => '0x' + b.toString(16).padStart(2, '0')).join(', ')}...]`);

        try {
            if (this.endpoint.out) {
                // Use bulk transfer
                log('Using bulk transfer (endpoint out)');
                const result = await this.device.transferOut(this.endpoint.out, packet);
                if (result.status !== 'ok') {
                    throw new Error(`Transfer failed: ${result.status}`);
                }
                log(`Bulk transfer OK, ${result.bytesWritten} bytes written`);
            } else {
                // Use control transfer
                log(`Using control transfer on interface ${this.interface.interfaceNumber}`);
                const result = await this.device.controlTransferOut({
                    requestType: 'class',
                    recipient: 'interface',
                    request: 0x09, // SET_REPORT
                    value: 0x200,  // HID output report
                    index: this.interface.interfaceNumber
                }, packet);
                if (result.status !== 'ok') {
                    throw new Error(`Control transfer failed: ${result.status}`);
                }
                log(`Control transfer OK, ${result.bytesWritten} bytes written`);
            }
        } catch (error) {
            log(`Send error: ${error.message}`);
            throw error;
        }
    }

    /**
     * Receive packet from device.
     *
     * Mirrors MakeCode's recvPacketAsync: one transferIn per call, no retry
     * loop.  Multiple concurrent transferIn calls poison the USB queue because
     * each abandoned promise still occupies a slot and consumes the next device
     * response.  We issue exactly one transfer and wait for it.
     */
    async receivePacket(timeout = 5000) {
        if (!this.connected) {
            throw new Error('Device not connected');
        }

        const startTime = Date.now();

        while (true) {
            let result;
            if (this.endpoint.in) {
                result = await this.device.transferIn(this.endpoint.in, 64);
            } else {
                result = await this.device.controlTransferIn({
                    requestType: 'class',
                    recipient: 'interface',
                    request: 0x01, // GET_REPORT
                    value: 0x100,  // HID input report
                    index: this.interface.interfaceNumber
                }, 64);
            }

            if (result.status !== 'ok') {
                throw new Error(`USB IN transfer failed: ${result.status}`);
            }

            const data = new Uint8Array(result.data.buffer);
            if (data.length > 0) {
                log(`Received packet (${Date.now() - startTime}ms): [${Array.from(data.slice(0, 8)).map(b => '0x' + b.toString(16).padStart(2, '0')).join(', ')}...]`);
                return data;
            }

            // Empty packet — check elapsed time before looping (mirrors MakeCode)
            if (timeout > 0 && Date.now() - startTime >= timeout) {
                throw new Error('USB IN timed out');
            }
        }
    }

    /**
     * Get device information
     */
    getDeviceInfo() {
        if (!this.device) return null;
        
        return {
            manufacturer: this.device.manufacturerName,
            product: this.device.productName,
            serialNumber: this.device.serialNumber,
            vendorId: '0x' + this.device.vendorId.toString(16).padStart(4, '0'),
            productId: '0x' + this.device.productId.toString(16).padStart(4, '0')
        };
    }

    /**
     * Check if device is connected
     */
    isConnected() {
        return this.connected && this.device !== null;
    }

    /**
     * Returns true when the connected device uses a Segger J-Link OB interface
     * (Calliope mini 2.0 / 2.1).  These devices do not support CMSIS-DAP and
     * must always be flashed via the DAPLink full-flash commands.
     */
    isJLink() {
        return this.device && this.device.vendorId === 0x1366;
    }

    /**
     * Check if a raw USBDevice matches the Calliope mini filters
     */
    isMatchingDevice(device) {
        return USB_FILTERS.some(f =>
            f.vendorId === device.vendorId &&
            (!f.productId || f.productId === device.productId)
        );
    }

    /**
     * Connect to an already-selected device (no user picker needed).
     * Used for auto-connect on USB plug-in events.
     */
    async connectToDevice(device) {
        this.device = device;
        return this.connect();
    }
}

// Global WebUSB device instance
let usbDevice = null;

/**
 * Initialize WebUSB
 */
function initWebUSB() {
    usbDevice = new WebUSBDevice();

    if ('usb' in navigator) {
        // Auto-connect when a previously-authorized device is plugged in
        navigator.usb.addEventListener('connect', async (event) => {
            if (usbDevice.isConnected()) return;
            if (!usbDevice.isMatchingDevice(event.device)) return;
            log('USB connect event: matched Calliope mini');
            if (usbDevice.onDeviceAppeared) {
                await usbDevice.onDeviceAppeared(event.device);
            }
        });

        // Handle physical removal of the device
        navigator.usb.addEventListener('disconnect', async (event) => {
            if (usbDevice.device === event.device) {
                log('USB disconnect event: device removed');
                await usbDevice.disconnect();
            }
        });
    }

    return usbDevice;
}

/**
 * Get or create WebUSB device instance
 */
function getUSBDevice() {
    if (!usbDevice) {
        usbDevice = initWebUSB();
    }
    return usbDevice;
}
