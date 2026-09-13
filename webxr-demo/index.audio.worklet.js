/**************************************************************************/
/*  audio.worklet.js                                                      */
/**************************************************************************/
/*                         This file is part of:                          */
/*                             GODOT ENGINE                               */
/*                        https://godotengine.org                         */
/**************************************************************************/
/* Copyright (c) 2014-present Godot Engine contributors (see AUTHORS.md). */
/* Copyright (c) 2007-2014 Juan Linietsky, Ariel Manzur.                  */
/*                                                                        */
/* Permission is hereby granted, free of charge, to any person obtaining  */
/* a copy of this software and associated documentation files (the        */
/* "Software"), to deal in the Software without restriction, including    */
/* without limitation the rights to use, copy, modify, merge, publish,    */
/* distribute, sublicense, and/or sell copies of the Software, and to     */
/* permit persons to whom the Software is furnished to do so, subject to  */
/* the following conditions:                                              */
/*                                                                        */
/* The above copyright notice and this permission notice shall be         */
/* included in all copies or substantial portions of the Software.        */
/*                                                                        */
/* THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,        */
/* EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF     */
/* MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. */
/* IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY   */
/* CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,   */
/* TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE      */
/* SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.                 */
/**************************************************************************/

class RingBuffer {
	constructor(p_buffer, p_state, p_threads) {
		this.buffer = p_buffer;
		this.avail = p_state;
		this.threads = p_threads;
		this.rpos = 0;
		this.wpos = 0;
	}

	data_left() {
		return this.threads ? Atomics.load(this.avail, 0) : this.avail;
	}

	space_left() {
		return this.buffer.length - this.data_left();
	}

	read(output) {
		const size = this.buffer.length;
		let from = 0;
		let to_write = output.length;
		if (this.rpos + to_write > size) {
			const high = size - this.rpos;
			output.set(this.buffer.subarray(this.rpos, size));
			from = high;
			to_write -= high;
			this.rpos = 0;
		}
		if (to_write) {
			output.set(this.buffer.subarray(this.rpos, this.rpos + to_write), from);
		}
		this.rpos += to_write;
		if (this.threads) {
			Atomics.add(this.avail, 0, -output.length);
			Atomics.notify(this.avail, 0);
		} else {
			this.avail -= output.length;
		}
	}

	write(p_buffer) {
		const to_write = p_buffer.length;
		const mw = this.buffer.length - this.wpos;
		if (mw >= to_write) {
			this.buffer.set(p_buffer, this.wpos);
			this.wpos += to_write;
			if (mw === to_write) {
				this.wpos = 0;
			}
		} else {
			const high = p_buffer.subarray(0, mw);
			const low = p_buffer.subarray(mw);
			this.buffer.set(high, this.wpos);
			this.buffer.set(low);
			this.wpos = low.length;
		}
		if (this.threads) {
			Atomics.add(this.avail, 0, to_write);
			Atomics.notify(this.avail, 0);
		} else {
			this.avail += to_write;
		}
	}
}

class GodotProcessor extends AudioWorkletProcessor {
	constructor() {
		super();
		this.threads = false;
		this.running = true;
		this.lock = null;
		this.notifier = null;
		this.output = null;
		this.output_buffer = new Float32Array();
		this.input = null;
		this.input_buffer = new Float32Array();
		this.port.onmessage = (event) => {
			const cmd = event.data['cmd'];
			const data = event.data['data'];
			this.parse_message(cmd, data);
		};
	}

	process_notify() {
		if (this.notifier) {
			Atomics.add(this.notifier, 0, 1);
			Atomics.notify(this.notifier, 0);
		}
	}

	parse_message(p_cmd, p_data) {
		if (p_cmd === 'start' && p_data) {
			const state = p_data[0];
			let idx = 0;
			this.threads = true;
			this.lock = state.subarray(idx, ++idx);
			this.notifier = state.subarray(idx, ++idx);
			const avail_in = state.subarray(idx, ++idx);
			const avail_out = state.subarray(idx, ++idx);
			this.input = new RingBuffer(p_data[1], avail_in, true);
			this.output = new RingBuffer(p_data[2], avail_out, true);
		} else if (p_cmd === 'stop') {
			this.running = false;
			this.output = null;
			this.input = null;
			this.lock = null;
			this.notifier = null;
		} else if (p_cmd === 'start_nothreads') {
			this.output = new RingBuffer(p_data[0], p_data[0].length, false);
		} else if (p_cmd === 'chunk') {
			this.output.write(p_data);
		}
	}

	process(inputs, outputs, parameters) {
		if (!this.running) {
			return false; // Stop processing.
		}
		if (this.output === null) {
			return true; // Not ready yet, keep processing.
		}
		this.mix_input(inputs[0]);
		this.mix_output(outputs[0]);
		this.process_notify();
		return true;
	}

	mix_input(channels) {
		if (!this.has_audio_frame(channels)) {
			return;
		}
		const sample_count = this.get_sample_count(channels);
		this.prepare_input_buffer(sample_count);
		if (this.threads && this.input.space_left() < sample_count) {
			// No room in the shared input ring; skip this frame.
			return;
		}
		GodotProcessor.write_input(this.input_buffer, channels);
		this.queue_input();
	}

	mix_output(channels) {
		if (!this.has_audio_frame(channels)) {
			return;
		}
		const sample_count = this.get_sample_count(channels);
		this.prepare_output_buffer(sample_count);
		if (this.output.data_left() < sample_count) {
			// The output ring has no complete frame to render yet.
			return;
		}
		this.output.read(this.output_buffer);
		GodotProcessor.write_output(channels, this.output_buffer);
		if (this.threads) {
			return;
		}
		this.port.postMessage({ 'cmd': 'read', 'data': sample_count });
	}

	has_audio_frame(channels) {
		return Boolean(channels?.length && channels[0]?.length);
	}

	get_sample_count(channels) {
		return channels[0].length * channels.length;
	}

	prepare_input_buffer(sample_count) {
		if (sample_count !== this.input_buffer.length) {
			this.input_buffer = new Float32Array(sample_count);
		}
	}

	prepare_output_buffer(sample_count) {
		if (sample_count === this.output_buffer.length) {
			return;
		}
		this.output_buffer = new Float32Array(sample_count);
	}

	queue_input() {
		if (this.threads) {
			this.input.write(this.input_buffer);
			return;
		}
		this.port.postMessage({ 'cmd': 'input', 'data': this.input_buffer });
	}

	static write_output(dest, source) {
		const channels = dest.length;
		for (let ch = 0; ch < channels; ch++) {
			for (let sample = 0; sample < dest[ch].length; sample++) {
				dest[ch][sample] = source[sample * channels + ch];
			}
		}
	}

	static write_input(dest, source) {
		const channels = source.length;
		for (let ch = 0; ch < channels; ch++) {
			for (let sample = 0; sample < source[ch].length; sample++) {
				dest[sample * channels + ch] = source[ch][sample];
			}
		}
	}
}

registerProcessor('godot-processor', GodotProcessor);
