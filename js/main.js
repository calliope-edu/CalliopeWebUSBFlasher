// Main application logic - UI and coordination

let hexFileContent = null;
let flashController = null;
let isFlashing = false;
let autoFlashEnabled = false;

// UI Elements
let elements = {};

// Note: usbDevice is defined in webusb.js as a global variable

/**
 * Initialize application
 */
document.addEventListener('DOMContentLoaded', () => {
    log('Calliope WebUSB Flasher initializing...');

    // Check browser compatibility
    const compat = checkBrowserCompatibility();
    if (!compat.supported) {
        showError(`Browser not supported: ${compat.reason}`);
        disableUI();
        return;
    }

    // Get UI elements
    elements = {
        hexFile: document.getElementById('hexFile'),
        dropZone: document.getElementById('dropZone'),
        selectFile: document.getElementById('selectFile'),
        fileInfo: document.getElementById('fileInfo'),
        connectBtn: document.getElementById('connectBtn'),
        flashBtn: document.getElementById('flashBtn'),
        cancelBtn: document.getElementById('cancelBtn'),
        deviceStatus: document.getElementById('deviceStatus'),
        firmwareVersion: document.getElementById('firmwareVersion'),
        progressBar: document.querySelector('.progress-fill'),
        progressPercent: document.getElementById('progressPercent'),
        progressStatus: document.getElementById('progressStatus'),
        statusMessage: document.getElementById('statusMessage'),
        errorMessage: document.getElementById('errorMessage'),
        partialFlash: document.getElementById('partialFlash'),
        verifyFlash: document.getElementById('verifyFlash'),
        autoFlash: document.getElementById('autoFlash')
    };

    // Initialize WebUSB
    usbDevice = initWebUSB();
    usbDevice.onConnectionChanged = onConnectionChanged;
    usbDevice.onDeviceAppeared = onDeviceAppeared;

    // Setup event listeners
    setupEventListeners();
    autoFlashEnabled = elements.autoFlash.checked;

    // Auto-connect to any already-authorized Calliope mini
    autoConnectExistingDevices();

    log('Initialization complete');
});

/**
 * Setup event listeners
 */
function setupEventListeners() {
    // File selection
    elements.selectFile.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        log('Select file button clicked');
        elements.hexFile.click();
    });

    elements.hexFile.addEventListener('change', (e) => {
        log('File input changed');
        if (e.target.files.length > 0) {
            loadHexFile(e.target.files[0]);
        }
    });

    // Drag and drop - prevent default on all drag events
    elements.dropZone.addEventListener('dragenter', (e) => {
        e.preventDefault();
        e.stopPropagation();
        log('File drag enter');
    });

    elements.dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        elements.dropZone.classList.add('drag-over');
    });

    elements.dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        e.stopPropagation();
        elements.dropZone.classList.remove('drag-over');
    });

    elements.dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        e.stopPropagation();
        log('File dropped');
        elements.dropZone.classList.remove('drag-over');
        
        if (e.dataTransfer.files.length > 0) {
            loadHexFile(e.dataTransfer.files[0]);
        }
    });

    // Also prevent default on document level to catch any missed events
    document.addEventListener('dragover', (e) => {
        e.preventDefault();
    });
    
    document.addEventListener('drop', (e) => {
        e.preventDefault();
    });

    // Device connection
    elements.connectBtn.addEventListener('click', connectDevice);

    // Flash button
    elements.flashBtn.addEventListener('click', startFlash);

    // Cancel button
    elements.cancelBtn.addEventListener('click', cancelFlash);

    // Auto-flash toggle
    elements.autoFlash.addEventListener('change', () => {
        autoFlashEnabled = elements.autoFlash.checked;
        log(`Auto-flash mode: ${autoFlashEnabled ? 'enabled' : 'disabled'}`);
    });
}

/**
 * Load HEX file
 */
async function loadHexFile(file) {
    hideMessages();

    if (!file.name.endsWith('.hex')) {
        showError('Please select a .hex file');
        return;
    }

    try {
        showStatus('Loading HEX file...');
        
        const text = await file.text();
        const validation = validateHexFile(text);

        if (!validation.valid) {
            showError(`Invalid HEX file: ${validation.error}`);
            return;
        }

        hexFileContent = text;

        const info = getHexFileInfo(text);
        elements.fileInfo.innerHTML = `
            ✓ <strong>${file.name}</strong><br>
            Size: ${formatBytes(info.totalSize)}, 
            Blocks: ${info.blocks}, 
            Range: ${info.startAddress} - ${info.endAddress}
        `;
        elements.fileInfo.classList.add('loaded');

        showStatus('HEX file loaded successfully');
        updateFlashButton();

        log(`Loaded ${file.name}: ${formatBytes(info.totalSize)}`);

    } catch (error) {
        showError(`Failed to load file: ${error.message}`);
        log(`File load error: ${error.message}`);
    }
}

/**
 * Connect to device
 */
async function connectDevice() {
    hideMessages();

    try {
        elements.connectBtn.disabled = true;
        showStatus('Requesting device access...');

        const selected = await usbDevice.requestDevice();
        if (!selected) {
            showStatus('Device selection cancelled');
            elements.connectBtn.disabled = false;
            return;
        }

        showStatus('Connecting to device...');
        await usbDevice.connect();

        const info = usbDevice.getDeviceInfo();
        elements.deviceStatus.textContent = `${info.product}`;
        elements.deviceStatus.classList.add('connected');

        // Get firmware version
        flashController = createFlashController(usbDevice);

        // Skip version check - it can interfere with subsequent commands
        elements.firmwareVersion.textContent = 'Ready';
        log('Device ready for flashing');

        updatePartialFlashUI();
        showStatus('Device connected successfully');
        updateFlashButton();

    } catch (error) {
        showError(`Connection failed: ${error.message}`);
        log(`Connection error: ${error.message}`);
        elements.connectBtn.disabled = false;
    }
}

/**
 * Start flashing
 */
async function startFlash() {
    if (!hexFileContent || !usbDevice.isConnected()) {
        showError('Please load a HEX file and connect a device first');
        return;
    }

    hideMessages();
    isFlashing = true;
    elements.flashBtn.disabled = true;
    elements.connectBtn.disabled = true;
    elements.cancelBtn.style.display = 'block';
    elements.flashBtn.classList.add('flashing');

    try {
        showStatus('Starting flash operation...');
        updateProgress(0, 'Preparing...');

        const options = {
            usePartialFlash: elements.partialFlash.checked,
            verifyAfterFlash: elements.verifyFlash.checked,
            progressCallback: updateProgress
        };

        log('Flashing device...');
        const result = await flashController.flash(hexFileContent, options);

        updateProgress(100, 'Flash complete!');
        const hint = autoFlashEnabled ? ' Unplug and reconnect next device to flash again.' : '';
        showStatus(`✓ Device flashed successfully using ${result.method} flash${hint}`);

        log('Flash completed successfully');

    } catch (error) {
        if (flashController.isAborted()) {
            showError('Flash operation cancelled');
        } else {
            showError(`Flash failed: ${error.message}`);
        }
        log(`Flash error: ${error.message}`);
        updateProgress(0, '');
    } finally {
        isFlashing = false;
        elements.flashBtn.disabled = false;
        elements.connectBtn.disabled = false;
        elements.cancelBtn.style.display = 'none';
        elements.flashBtn.classList.remove('flashing');
    }
}

/**
 * Cancel flashing
 */
function cancelFlash() {
    if (flashController && isFlashing) {
        flashController.abort();
        log('Flash cancelled by user');
    }
}

/**
 * Update progress bar
 */
function updateProgress(percent, status) {
    elements.progressBar.style.width = `${percent}%`;
    elements.progressPercent.textContent = `${Math.round(percent)}%`;
    if (status) {
        elements.progressStatus.textContent = status;
    }
}

/**
 * Enable or disable the partial-flash checkbox depending on the connected device.
 * J-Link OB (Calliope mini 2.x) does not support CMSIS-DAP partial flash.
 */
function updatePartialFlashUI() {
    if (usbDevice && usbDevice.isJLink()) {
        elements.partialFlash.checked = false;
        elements.partialFlash.disabled = true;
        elements.partialFlash.title = 'Calliope mini 2.x: always full flash via J-Link MSD protocol';
        log('Partial flash disabled: J-Link MSD always flashes all pages');
    } else {
        elements.partialFlash.disabled = false;
        elements.partialFlash.title = '';
    }
}

/**
 * Connection changed callback
 */
function onConnectionChanged(connected) {
    if (connected) {
        elements.connectBtn.textContent = '✓ Connected';
        elements.connectBtn.classList.add('connected');
    } else {
        elements.connectBtn.textContent = 'Connect Device';
        elements.connectBtn.classList.remove('connected');
        elements.deviceStatus.textContent = 'Not connected';
        elements.deviceStatus.classList.remove('connected');
        elements.firmwareVersion.textContent = '-';
        flashController = null;
        // Re-enable partial flash checkbox so it's ready for the next device
        elements.partialFlash.disabled = false;
        elements.partialFlash.title = '';
    }
    updateFlashButton();
}

/**
 * Update flash button state
 */
function updateFlashButton() {
    const canFlash = hexFileContent && usbDevice && usbDevice.isConnected();
    elements.flashBtn.disabled = !canFlash || isFlashing;
}

/**
 * Show status message
 */
function showStatus(message) {
    elements.statusMessage.textContent = message;
    elements.statusMessage.classList.add('show');
    elements.errorMessage.classList.remove('show');
}

/**
 * Show error message
 */
function showError(message) {
    elements.errorMessage.textContent = message;
    elements.errorMessage.classList.add('show');
    elements.statusMessage.classList.remove('show');
}

/**
 * Hide all messages
 */
function hideMessages() {
    elements.statusMessage.classList.remove('show');
    elements.errorMessage.classList.remove('show');
}

/**
 * Disable UI
 */
function disableUI() {
    elements.selectFile.disabled = true;
    elements.connectBtn.disabled = true;
    elements.flashBtn.disabled = true;
    elements.dropZone.style.opacity = '0.5';
    elements.dropZone.style.pointerEvents = 'none';
}

/**
 * Called automatically when a known USB device is plugged in.
 * Connects and optionally starts flashing without any user interaction.
 */
async function onDeviceAppeared(device) {
    if (isFlashing) return;
    hideMessages();
    try {
        showStatus('Calliope mini detected — connecting automatically...');
        await usbDevice.connectToDevice(device);

        const info = usbDevice.getDeviceInfo();
        elements.deviceStatus.textContent = info.product;
        elements.deviceStatus.classList.add('connected');

        flashController = createFlashController(usbDevice);
        elements.firmwareVersion.textContent = 'Ready';
        updatePartialFlashUI();
        updateFlashButton();

        if (autoFlashEnabled && hexFileContent) {
            showStatus('Auto-flash: starting...');
            await startFlash();
        } else if (autoFlashEnabled && !hexFileContent) {
            showStatus('Device connected. Load a HEX file to enable auto-flash.');
        } else {
            showStatus('Device connected automatically. Click "Flash Device" to flash.');
        }
    } catch (error) {
        showError(`Auto-connect failed: ${error.message}`);
        log(`Auto-connect error: ${error.message}`);
    }
}

/**
 * Scan for already-authorized Calliope mini devices on page load.
 * These were authorized in a previous browser session and need no user gesture.
 */
async function autoConnectExistingDevices() {
    try {
        const devices = await navigator.usb.getDevices();
        for (const device of devices) {
            if (usbDevice.isMatchingDevice(device) && !usbDevice.isConnected()) {
                log('Found previously authorized Calliope mini, auto-connecting...');
                await usbDevice.onDeviceAppeared(device);
                break;
            }
        }
    } catch (error) {
        log(`Auto-connect scan failed: ${error.message}`);
    }
}
