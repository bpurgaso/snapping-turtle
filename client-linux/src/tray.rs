//! The StatusNotifierItem tray icon and its menu (ksni). Plasma renders it
//! natively; GNOME needs the AppIndicator extension (README). Menu clicks
//! turn into `Command`s on the resident loop; the tooltip shows the last
//! result — with the capture URL redacted like everywhere else.

use crate::app_id::{APP_ID, ICON_NAME, PRODUCT_NAME};
use crate::capture::Mode;
use crate::ipc::Command;
use ksni::menu::{MenuItem, StandardItem};
use ksni::{Icon, ToolTip, Tray, TrayMethods};
use tokio::sync::mpsc::UnboundedSender;

// Shipped at packaging/icons/hicolor/<size>/apps/snapping-turtle.png; embedded
// so the icon shows even where the hicolor theme copy is not installed.
const ICON_32: &[u8] = include_bytes!("../packaging/icons/hicolor/32x32/apps/snapping-turtle.png");
const ICON_64: &[u8] = include_bytes!("../packaging/icons/hicolor/64x64/apps/snapping-turtle.png");

pub struct AppTray {
    tx: UnboundedSender<Command>,
    pub status: String,
    pub has_last: bool,
    pub busy: bool,
    pixmaps: Vec<Icon>,
}

fn pixmap(png: &[u8]) -> Option<Icon> {
    let (w, h, rgba) = crate::capture::raw_image::decode_png(png).ok()?;
    // SNI wants ARGB32 in network byte order: A R G B per pixel.
    let data = rgba
        .as_chunks::<4>()
        .0
        .iter()
        .flat_map(|p| [p[3], p[0], p[1], p[2]])
        .collect();
    Some(Icon {
        width: w as i32,
        height: h as i32,
        data,
    })
}

impl AppTray {
    pub fn new(tx: UnboundedSender<Command>) -> Self {
        AppTray {
            tx,
            status: "Ready".into(),
            has_last: false,
            busy: false,
            pixmaps: [ICON_32, ICON_64]
                .iter()
                .filter_map(|b| pixmap(b))
                .collect(),
        }
    }

    fn item(&self, label: &str, cmd: Command, enabled: bool) -> MenuItem<Self> {
        StandardItem {
            label: label.into(),
            enabled,
            activate: Box::new(move |this: &mut Self| {
                let _ = this.tx.send(cmd);
            }),
            ..Default::default()
        }
        .into()
    }
}

impl Tray for AppTray {
    fn id(&self) -> String {
        APP_ID.into()
    }

    fn title(&self) -> String {
        PRODUCT_NAME.into()
    }

    fn icon_name(&self) -> String {
        ICON_NAME.into()
    }

    fn icon_pixmap(&self) -> Vec<Icon> {
        self.pixmaps.clone()
    }

    fn tool_tip(&self) -> ToolTip {
        ToolTip {
            title: PRODUCT_NAME.into(),
            description: self.status.clone(),
            ..Default::default()
        }
    }

    fn menu(&self) -> Vec<MenuItem<Self>> {
        let mut items: Vec<MenuItem<Self>> = Mode::ALL
            .iter()
            .map(|m| self.item(m.menu_label(), Command::Capture(*m), !self.busy))
            .collect();
        items.push(MenuItem::Separator);
        items.push(self.item("Open last capture", Command::OpenLast, self.has_last));
        items.push(MenuItem::Separator);
        items.push(self.item("Quit", Command::Quit, true));
        items
    }
}

pub async fn spawn(tx: UnboundedSender<Command>) -> Result<ksni::Handle<AppTray>, String> {
    AppTray::new(tx).spawn().await.map_err(|e| e.to_string())
}
