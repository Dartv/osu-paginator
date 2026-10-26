'use strict';

// Calendar dates as "YYYY-MM-DD" strings, computed in UTC so DST never shifts a day.
const OspDate = {
  // Month is 0-based and may overflow (e.g. day 0 = last day of the previous month).
  ymd(y, m, d) {
    const dt = new Date(Date.UTC(y, m, d));
    const pad = (n) => String(n).padStart(2, '0');
    return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
  },

  parts(s) {
    return s.split('-').map(Number);
  },

  addDays(s, n) {
    const [y, m, d] = OspDate.parts(s);
    return OspDate.ymd(y, m - 1, d + n);
  },

  today() {
    const t = new Date();
    return OspDate.ymd(t.getFullYear(), t.getMonth(), t.getDate());
  },

  isValid(s) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
    const [y, m, d] = OspDate.parts(s);
    return OspDate.ymd(y, m - 1, d) === s;
  },

  format(s) {
    const [y, m, d] = OspDate.parts(s);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
    });
  },
};

// Popover calendar for picking a start/end range. The caller appends `el` to a
// positioned container and gets the chosen range through `onCommit({ from, to })`.
class DateRangePicker {
  constructor({ minYear, onCommit }) {
    this.minYear = minYear;
    this.onCommit = onCommit;
    this.anchor = null;
    this.from = '';
    this.to = '';
    this.hover = '';
    this.mode = 'new'; // 'new' starts a fresh range, 'from'/'to' edit one end
    this.view = { y: 0, m: 0 };

    this.el = document.createElement('div');
    this.el.className = 'osp-picker';
    this.el.hidden = true;
    this.el.innerHTML = this.template();
    this.fromInput = this.el.querySelector('.osp-picker__from');
    this.toInput = this.el.querySelector('.osp-picker__to');
    this.bindEvents();
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open(anchor, { from, to }) {
    this.anchor = anchor;
    this.from = from;
    this.to = to;
    this.initial = { from, to };
    this.hover = '';
    this.mode = 'new';
    const [y, m] = OspDate.parts(from || to || OspDate.today());
    this.view = { y, m: m - 1 };
    this.el.hidden = false;
    this.render();
    this.position();
  }

  close(commit) {
    if (!this.isOpen) return;
    this.el.hidden = true;
    this.anchor = null;
    const changed = this.from !== this.initial.from || this.to !== this.initial.to;
    if (commit && changed) this.onCommit({ from: this.from, to: this.to });
  }

  position() {
    const parent = this.el.offsetParent;
    if (!parent) return;
    const box = parent.getBoundingClientRect();
    const target = this.anchor.getBoundingClientRect();
    const maxLeft = Math.max(0, box.width - this.el.offsetWidth);
    this.el.style.top = `${target.bottom - box.top + 6}px`;
    this.el.style.left = `${Math.min(Math.max(0, target.left - box.left), maxLeft)}px`;
  }

  template() {
    const months = Array.from({ length: 12 }, (_, i) =>
      `<option value="${i}">${new Date(Date.UTC(2000, i, 1)).toLocaleDateString(undefined, { month: 'long', timeZone: 'UTC' })}</option>`).join('');
    let years = '';
    for (let y = new Date().getFullYear(); y >= this.minYear; y--) years += `<option value="${y}">${y}</option>`;
    const weekdays = Array.from({ length: 7 }, (_, i) =>
      `<span>${new Date(Date.UTC(2000, 0, 2 + i)).toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' }).slice(0, 2)}</span>`).join('');

    return `
      <div class="osp-picker__fields">
        <label class="osp-picker__field" data-end="from">
          <span>Start</span>
          <input class="osp-picker__from" placeholder="YYYY-MM-DD" autocomplete="off" spellcheck="false">
          <button type="button" class="osp-picker__x" data-clear="from" aria-label="Clear start">×</button>
        </label>
        <label class="osp-picker__field" data-end="to">
          <span>End</span>
          <input class="osp-picker__to" placeholder="YYYY-MM-DD" autocomplete="off" spellcheck="false">
          <button type="button" class="osp-picker__x" data-clear="to" aria-label="Clear end">×</button>
        </label>
      </div>
      <div class="osp-picker__head">
        <select class="osp-picker__month" aria-label="Month">${months}</select>
        <select class="osp-picker__year" aria-label="Year">${years}</select>
        <button type="button" class="osp-picker__today">Today</button>
        <button type="button" class="osp-picker__nav" data-nav="-1" aria-label="Previous month">‹</button>
        <button type="button" class="osp-picker__nav" data-nav="1" aria-label="Next month">›</button>
      </div>
      <div class="osp-picker__weekdays">${weekdays}</div>
      <div class="osp-picker__grid"></div>
      <div class="osp-picker__presets">
        <button type="button" data-preset="month">Whole month</button>
        <button type="button" data-preset="year">Whole year</button>
        <button type="button" data-preset="30d">Last 30 days</button>
        <button type="button" data-preset="365d">Last 12 months</button>
      </div>
      <div class="osp-picker__foot">
        <button type="button" class="osp-picker__reset">Clear</button>
        <button type="button" class="osp-picker__done">Done</button>
      </div>`;
  }

  bindEvents() {
    this.el.addEventListener('click', (e) => {
      const t = e.target;
      const day = t.closest('[data-date]');
      if (day) return this.pick(day.dataset.date);
      const nav = t.closest('[data-nav]');
      if (nav) return this.shiftView(Number(nav.dataset.nav));
      const clear = t.closest('[data-clear]');
      if (clear) {
        e.preventDefault(); // keep the label from refocusing its input
        this[clear.dataset.clear] = '';
        this.mode = clear.dataset.clear;
        return this.render();
      }
      const preset = t.closest('[data-preset]');
      if (preset) return this.applyPreset(preset.dataset.preset);
      if (t.closest('.osp-picker__today')) {
        const [y, m] = OspDate.parts(OspDate.today());
        this.view = { y, m: m - 1 };
        return this.render();
      }
      if (t.closest('.osp-picker__reset')) {
        this.from = this.to = '';
        return this.close(true);
      }
      if (t.closest('.osp-picker__done')) this.close(true);
    });

    this.el.addEventListener('change', (e) => {
      if (e.target.matches('.osp-picker__month, .osp-picker__year')) {
        this.view = {
          y: Number(this.el.querySelector('.osp-picker__year').value),
          m: Number(this.el.querySelector('.osp-picker__month').value),
        };
        this.render();
      } else if (e.target.matches('.osp-picker__from, .osp-picker__to')) {
        this.typed(e.target);
      }
    });

    this.el.addEventListener('focusin', (e) => {
      const field = e.target.closest('[data-end]');
      if (field) {
        this.mode = field.dataset.end;
        this.renderFields();
      }
    });

    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.matches('input')) this.typed(e.target);
    });

    const grid = this.el.querySelector('.osp-picker__grid');
    grid.addEventListener('mouseover', (e) => {
      const day = e.target.closest('[data-date]');
      if (day && this.mode === 'to' && this.from && !this.to && day.dataset.date !== this.hover) {
        this.hover = day.dataset.date;
        this.paintRange();
      }
    });
    grid.addEventListener('mouseleave', () => {
      if (!this.hover) return;
      this.hover = '';
      this.paintRange();
    });

    document.addEventListener('mousedown', (e) => {
      if (this.isOpen && !this.el.contains(e.target) && !this.anchor?.contains(e.target)) this.close(true);
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.isOpen) {
        this.from = this.initial.from;
        this.to = this.initial.to;
        this.close(false);
      }
    });
  }

  pick(date) {
    if (this.mode === 'to' && this.from) {
      if (date < this.from) [this.from, this.to] = [date, this.from];
      else this.to = date;
      return this.close(true);
    }
    if (this.mode === 'from' && this.to && date <= this.to) {
      this.from = date;
      return this.close(true);
    }
    this.from = date;
    this.to = '';
    this.hover = '';
    this.mode = 'to';
    this.render();
  }

  typed(input) {
    const end = input === this.fromInput ? 'from' : 'to';
    const value = input.value.trim();
    if (value && !OspDate.isValid(value)) {
      input.classList.add('osp-picker__input--bad');
      return;
    }
    input.classList.remove('osp-picker__input--bad');
    this[end] = value;
    if (this.from && this.to && this.from > this.to) [this.from, this.to] = [this.to, this.from];
    if (value) {
      const [y, m] = OspDate.parts(value);
      this.view = { y, m: m - 1 };
    }
    this.render();
  }

  applyPreset(preset) {
    const { y, m } = this.view;
    const today = OspDate.today();
    if (preset === 'month') [this.from, this.to] = [OspDate.ymd(y, m, 1), OspDate.ymd(y, m + 1, 0)];
    else if (preset === 'year') [this.from, this.to] = [OspDate.ymd(y, 0, 1), OspDate.ymd(y, 11, 31)];
    else if (preset === '30d') [this.from, this.to] = [OspDate.addDays(today, -29), today];
    else if (preset === '365d') [this.from, this.to] = [OspDate.addDays(today, -364), today];
    this.close(true);
  }

  shiftView(delta) {
    const [y, m] = OspDate.parts(OspDate.ymd(this.view.y, this.view.m + delta, 1));
    if (y < this.minYear) return;
    this.view = { y, m: m - 1 };
    this.render();
  }

  render() {
    this.renderFields();
    const yearSelect = this.el.querySelector('.osp-picker__year');
    if (!yearSelect.querySelector(`option[value="${this.view.y}"]`)) {
      yearSelect.insertAdjacentHTML('afterbegin', `<option value="${this.view.y}">${this.view.y}</option>`);
    }
    yearSelect.value = this.view.y;
    this.el.querySelector('.osp-picker__month').value = this.view.m;
    this.renderGrid();
  }

  renderFields() {
    if (document.activeElement !== this.fromInput) this.fromInput.value = this.from;
    if (document.activeElement !== this.toInput) this.toInput.value = this.to;
    this.el.querySelectorAll('[data-end]').forEach((field) => {
      const active = this.mode === field.dataset.end || (this.mode === 'new' && field.dataset.end === 'from');
      field.classList.toggle('osp-picker__field--active', active);
    });
  }

  renderGrid() {
    const { y, m } = this.view;
    const first = OspDate.ymd(y, m, 1);
    const offset = new Date(Date.UTC(y, m, 1)).getUTCDay(); // weeks start on Sunday
    const today = OspDate.today();

    let html = '';
    for (let i = 0; i < 42; i++) {
      const date = OspDate.addDays(first, i - offset);
      const [, dm, dd] = OspDate.parts(date);
      const cls = ['osp-picker__day'];
      if (dm - 1 !== m) cls.push('osp-picker__day--outside');
      if (date === today) cls.push('osp-picker__day--today');
      html += `<button type="button" class="${cls.join(' ')}" data-date="${date}">${dd}</button>`;
    }
    this.el.querySelector('.osp-picker__grid').innerHTML = html;
    this.paintRange();
  }

  // Only toggles classes: replacing the buttons mid-click would swallow the click.
  paintRange() {
    let lo = this.from;
    let hi = this.to || (this.mode === 'to' ? this.hover : '');
    if (lo && hi && hi < lo) [lo, hi] = [hi, lo];
    this.el.querySelectorAll('.osp-picker__day').forEach((day) => {
      const date = day.dataset.date;
      const edge = date === lo || date === hi;
      day.classList.toggle('osp-picker__day--edge', edge);
      day.classList.toggle('osp-picker__day--range', !edge && Boolean(lo && hi) && date > lo && date < hi);
    });
  }
}
