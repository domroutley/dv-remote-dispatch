const SwitchboardOccupancy = {
    mode: 'direct',

    setMode(mode) {
        if (this.mode === mode) return;
        this.mode = mode;
        console.log(`[SwitchboardOccupancy] mode set to: ${mode}`);
        this.sendMode();
    },

    sendMode() {
        const modeValue = this.mode === 'direct' ? 1 : 0;
        fetch(new URL('/occupancy', location), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: modeValue })
        }).catch(err => {
            console.error('Failed to set occupancy mode:', err);
        });
    },

    get isActive() {
        return this.mode === 'direct';
    }
};
