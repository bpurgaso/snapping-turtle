//! Generated capture titles: `<mode> <local date> <local time>`, e.g.
//! `Full screen 2026-09-03 21:14:05`. The server keeps the title as data
//! (`cleanTitle`), so this is plain text with no markup concerns.

use crate::capture::Mode;

pub struct LocalTime {
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub hour: u32,
    pub minute: u32,
    pub second: u32,
}

/// Wall-clock local time via `localtime_r` (honours TZ and /etc/localtime).
pub fn local_now() -> LocalTime {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as libc::time_t)
        .unwrap_or(0);
    // SAFETY: localtime_r writes only into the zeroed `tm` we pass; `now` outlives the call.
    let tm = unsafe {
        let mut tm: libc::tm = std::mem::zeroed();
        libc::localtime_r(&now, &mut tm);
        tm
    };
    LocalTime {
        year: tm.tm_year + 1900,
        month: (tm.tm_mon + 1) as u32,
        day: tm.tm_mday as u32,
        hour: tm.tm_hour as u32,
        minute: tm.tm_min as u32,
        second: tm.tm_sec as u32,
    }
}

pub fn format(mode: Mode, t: &LocalTime) -> String {
    format!(
        "{} {:04}-{:02}-{:02} {:02}:{:02}:{:02}",
        mode.label(),
        t.year,
        t.month,
        t.day,
        t.hour,
        t.minute,
        t.second
    )
}

pub fn capture_title(mode: Mode) -> String {
    format(mode, &local_now())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_mode_and_timestamp() {
        let t = LocalTime {
            year: 2026,
            month: 9,
            day: 3,
            hour: 21,
            minute: 14,
            second: 5,
        };
        assert_eq!(format(Mode::Full, &t), "Full screen 2026-09-03 21:14:05");
        assert_eq!(format(Mode::Window, &t), "Window 2026-09-03 21:14:05");
        assert_eq!(format(Mode::Region, &t), "Region 2026-09-03 21:14:05");
    }

    #[test]
    fn local_now_is_a_plausible_date() {
        let t = local_now();
        assert!(t.year >= 2026);
        assert!((1..=12).contains(&t.month) && (1..=31).contains(&t.day));
    }
}
