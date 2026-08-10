# Thiết kế lộ trình refactor giao diện SSH Lite

- **Ngày:** 2026-08-10
- **Phiên bản hiện tại:** 1.0.5
- **Các phiên bản dự kiến:** 1.0.6 đến 1.0.10
- **Trạng thái:** Đã duyệt hướng hình ảnh và phạm vi; cần duyệt mockup trước mỗi đợt implement

## Nhật ký duyệt mockup

- **2026-08-10 — Đã duyệt:** nền tảng native sidebar 1.0.6, gồm hướng A2, số lượng action icon hiển thị bằng chính xác phiên bản 1.0.5, thứ tự action nhất quán, inline slot cố định, mockup mặc định theo hệ thống và chế độ Sáng/Tối để review.
- **2026-08-10 — Đã duyệt:** năm state SSH Hosts gồm bình thường, đã kết nối, kết nối lại, lỗi và rỗng; header luôn 6 action icon, inline action lần lượt 0/3/1/0/0 đúng bằng phiên bản 1.0.5.
- **2026-08-10 — Đã duyệt:** Remote Files dùng “Tìm kiếm nâng cao” cho màn hình Search đầy đủ và “Quét sâu theo bộ lọc” cho filename deep scan; hai action dùng glyph riêng, giữ nguyên số icon và tooltip giải thích dữ liệu tìm, phạm vi cùng nơi hiển thị kết quả.
- **2026-08-10 — Đã duyệt:** năm state Remote Files gồm mặc định, đang lọc, loading, upload lỗi và thư mục rỗng; header giữ 10 icon ở trạng thái thường, 11 khi filter active và inline action giữ 5/4/4.
- **Tiếp theo:** duyệt state chi tiết của Activity, Port Forwards và native dialog/feedback trước khi viết implementation plan 1.0.6.

## Mục tiêu

Refactor và thiết kế lại toàn bộ Giao diện người dùng (UI) của SSH Lite mà không làm người dùng hiện tại bị ngợp. Mỗi phiên bản chỉ thay đổi một khu vực lớn, giữ vị trí quen thuộc và luồng thao tác cốt lõi, đồng thời áp dụng một hệ thống hình ảnh và tương tác nhất quán cho mọi màn hình.

Đây không phải đợt sửa màu và khoảng cách bề mặt. Công việc gồm:

- kiểm tra từng icon lệnh và mọi vị trí icon xuất hiện;
- thiết kế lại từng module, màn hình và zone bên trong;
- tách HyperText Markup Language (HTML), Cascading Style Sheets (CSS) và logic render đang viết inline khi chúng cản trở tái sử dụng hoặc kiểm thử;
- xây dựng token hình ảnh và pattern tương tác dùng chung;
- kiểm tra responsive, bàn phím, độ tương phản, reduced motion, diagnostic logging, empty state, loading state và error recovery;
- dựng mockup đầy đủ để người dùng duyệt trước khi viết code cho từng phiên bản.

## Hướng hình ảnh đã duyệt

Hướng đã chọn là **A2: dấu ấn Secure Shell (SSH) nhẹ**.

Bố cục tiếp tục dày thông tin và quen thuộc như Visual Studio Code (VS Code). Một màu amber tiết chế tạo dấu ấn SSH Lite, gợi terminal và trạng thái kết nối. Amber chỉ dùng cho nhận diện sản phẩm, cấu trúc đang chọn hoặc ngữ cảnh kết nối có ý nghĩa. Amber không được là tín hiệu duy nhất cho trạng thái hay mức độ nghiêm trọng.

Hướng luồng nhiều bước đã bị loại vì thay đổi cấu trúc quá lớn và buộc người dùng học lại thao tác quen thuộc.

## Nguyên tắc thiết kế

1. **Bên ngoài quen thuộc, bên trong tốt hơn.** Giữ view identifier, command location, zone chính và vị trí action thường dùng. Refactor sâu cấu trúc và cách trình bày bên trong.
2. **Mỗi phiên bản chỉ có một thay đổi lớn.** Người dùng chỉ cần làm quen một khu vực tại một thời điểm.
3. **Một ý nghĩa dùng một icon.** Cùng action phải dùng cùng Codicon, label, tooltip, slot và ngôn ngữ trạng thái trên mọi màn hình.
4. **Cấu trúc thể hiện mức ưu tiên.** Header, toolbar, row, description, badge và divider phải diễn đạt hierarchy thật.
5. **Dữ liệu phải đầy đủ và trung thực.** Không được truncate, filter, ẩn hoặc ước lượng dữ liệu remote chỉ để giao diện gọn hơn.
6. **Ưu tiên native.** Dùng VS Code theme variable, Codicon, ThemeIcon, focus behavior và native control. Dấu ấn A2 chỉ bổ sung, không đối đầu host environment.
7. **Accessibility là một phần của component contract.** Keyboard access, visible focus, contrast, tín hiệu không phụ thuộc màu, reduced motion và narrow-width behavior đều là acceptance criteria.
8. **Diagnostic tập trung một chỗ.** Mọi tương tác webview mới tiếp tục gửi structured log về duy nhất output channel SSH Lite.
9. **Không implement trước khi duyệt mockup.** Mỗi màn hình và zone phải có mockup đúng state, đúng breakpoint và được người dùng duyệt.
10. **Không thay đổi số lượng icon đang hiển thị.** Mỗi toolbar, row và state phải giữ đúng số action icon đang thấy ở cùng ngữ cảnh trong phiên bản 1.0.5: không tăng, không giảm. Được đổi icon và sắp xếp lại để bảo đảm tính nhất quán giữa module và screen; không được thêm action mới hoặc đẩy action đang hiện vào overflow chỉ để giao diện trông gọn hơn.
11. **Action liền kề phải phân biệt bằng mắt và tên.** “Lọc tệp” dùng phễu `filter`; “Tìm kiếm nâng cao” dùng `search`; “Quét sâu theo bộ lọc” dùng `remote-explorer`. Mở rộng và thu gọn dùng `expand-all`, `fold-down`, `collapse-all` theo đúng action kế tiếp của trạng thái cây, không dùng một icon gộp mơ hồ.
12. **Tooltip phải giải thích hành vi.** Với action dễ nhầm, tooltip phải nói rõ đối tượng được tìm, phạm vi thực thi và nơi hiển thị kết quả; không được chỉ lặp lại tên action.

## Inventory giao diện hiện tại

Audit ban đầu xác nhận:

- 117 contributed command, tất cả có command icon;
- 36 action trong `view/title`;
- 88 action trong `view/item/context`;
- 180 lần tham chiếu Codicon, gồm 41 Codicon khác nhau;
- 16 lần tạo ThemeIcon, gồm 12 tên ThemeIcon khác nhau;
- bốn native tree module;
- năm webview module;
- nhiều Quick Pick, Input Box, notification, status bar, editor title và editor context surface.

### Native tree module

1. SSH Hosts
2. Remote Files
3. Activity
4. Port Forwards

### Webview module

1. Search
2. Server Monitor
3. Connection Import
4. Donate
5. Support và Non-Player Character (NPC)

## Cổng duyệt mockup bắt buộc

Không phiên bản nào được chuyển sang implementation plan hoặc sửa source trước khi hoàn thành đủ quy trình sau.

### Bước 1: Chụp trạng thái hiện tại

- ghi lại màn hình hiện tại ở light theme và dark theme;
- ghi lại normal width và narrow width;
- ghi lại active, selected, disabled, loading, empty, warning và error state đang có;
- liệt kê icon, label, tooltip, slot và action trong từng zone.

### Bước 2: Dựng mockup mới

Mỗi screen/module phải có:

- mockup toàn màn hình;
- mockup chi tiết cho từng zone;
- light theme và dark theme;
- normal width và narrow width;
- default, hover, focus, selected, disabled, loading, empty, success, warning, error và destructive state áp dụng cho màn hình đó;
- chú thích icon cũ, icon mới, vị trí, lý do đổi và ảnh hưởng đến thói quen người dùng.

Công cụ duyệt mockup dùng ba chế độ hiển thị: **Theo hệ thống** là mặc định, bên cạnh **Sáng** và **Tối**. Đây là control phục vụ review mockup; giao diện sản phẩm vẫn theo Visual Studio Code theme variable và không thêm một theme switch riêng.

### Bước 3: So sánh xuyên màn hình

Một board riêng phải đặt các screen cạnh nhau để kiểm tra:

- token màu và amber accent;
- spacing, border, radius và typography;
- header, toolbar, row, table, tabs, footer và feedback pattern;
- icon semantic và inline slot;
- responsive behavior;
- keyboard, focus, contrast và reduced motion;
- copy và tên action.

### Bước 4: Người dùng duyệt

Người dùng có thể:

- duyệt toàn bộ mockup của phiên bản;
- yêu cầu sửa một screen;
- yêu cầu sửa một zone;
- yêu cầu đổi icon hoặc action cụ thể;
- từ chối thay đổi làm lệch thói quen hiện tại.

Mọi yêu cầu sửa phải được cập nhật lại mockup và duyệt lại. Chỉ trạng thái duyệt rõ ràng mới mở cổng implementation.

### Bước 5: Viết implementation plan

Sau khi mockup được duyệt:

- implementation plan phải bám đúng mockup;
- mỗi task phải trỏ đến version, screen/module, zone và state cụ thể;
- mọi khác biệt phát sinh khi code phải quay lại mockup để duyệt, không tự ý thay đổi.

## Tài liệu audit icon bắt buộc

Phiên bản 1.0.6 tạo và duy trì `.adn/configuration/ui-icon-audit.md`. Tài liệu có một row cho từng contributed command và từng icon programmatic xuất hiện trên user-facing surface.

Mỗi row ghi:

- command hoặc element identifier;
- module và zone;
- placement: title, inline slot, context menu, Quick Pick, status bar hoặc webview;
- icon hiện tại và icon đề xuất;
- semantic category: navigation, create, read, update, delete, connection, terminal, search, filter, status hoặc support;
- visible label và tooltip;
- normal, hover, selected, disabled, loading, success, warning và destructive state áp dụng;
- light-theme và dark-theme behavior;
- quyết định keep, replace, merge, move hoặc remove;
- mockup đã duyệt;
- test và screenshot dùng để verify.

Không release nào vượt consistency gate khi còn icon áp dụng chưa được phân loại.

## Kiến trúc giao diện dùng chung

### Visual token

Tạo token A2 dùng chung cho:

- VS Code semantic color;
- amber identity accent tiết chế;
- spacing scale;
- border và divider;
- corner radius;
- typography role;
- dense layout và narrow layout;
- focus, hover, selected, disabled, loading, success, warning, error và destructive state;
- animation duration và reduced-motion alternative.

Webview dùng token qua shared CSS. Native tree dùng giá trị tương đương qua VS Code theme color, ThemeIcon, description, context value và menu contract.

### Webview pattern dùng lại

Pattern dùng chung gồm:

- screen header;
- zone header và toolbar;
- primary button và secondary button;
- icon button;
- form row và disclosure;
- list row và tree row;
- table;
- tabs;
- badge và status label;
- progress và refresh state;
- empty, loading, warning và error state;
- panel footer;
- narrow-width wrapping và overflow.

Không migration sang framework mới. Các CSS class và function nhỏ đủ phù hợp kiến trúc extension hiện tại, ít rủi ro hơn.

### Ranh giới webview module

Search và Support đã có module riêng trong `webview-src`. Server Monitor, Connection Import và Donate đang nhúng lượng lớn markup/style vào TypeScript service hoặc panel file. Phiên bản tương ứng sẽ chuyển presentation sang webview module riêng.

Ranh giới trách nhiệm:

1. extension code validate và serialize trusted state;
2. webview renderer hiển thị state bằng shared token và pattern;
3. webview gửi typed action nhỏ;
4. extension code validate action rồi mới thực hiện side effect;
5. cả hai phía forward diagnostic event về output channel SSH Lite.

### Ranh giới native surface

Native tree row không nhận custom CSS. Phần redesign dùng:

- TreeItem identifier ổn định;
- ThemeIcon nhất quán;
- label và description ngắn, rõ;
- collapse state có thể dự đoán;
- canonical inline icon slot;
- context-menu order khớp nhau;
- loading, disconnected, empty, filtered, running, success, warning và error state rõ;
- Quick Pick và Input Box dùng cùng tên action với tree và webview.

## Contract nhất quán xuyên màn hình

### Cấu trúc zone

Khi áp dụng được, zone theo thứ tự:

1. screen identity và primary status;
2. primary action;
3. secondary control hoặc disclosure;
4. main content;
5. progress hoặc contextual status;
6. empty, loading, warning hoặc error guidance;
7. destructive hoặc final action ở footer ổn định.

### Ngôn ngữ icon

- Một semantic action chỉ dùng một Codicon trên mọi module.
- Icon xuất hiện trên nhiều tree row type phải giữ cùng canonical inline slot.
- Icon-only control phải có accessible label và tooltip hữu ích.
- Destructive action dùng destructive styling và verb rõ.
- Loading chỉ dùng spinner khi tác vụ đang chạy.
- Success, warning và error phải ghép icon, text và theme color; không phụ thuộc màu.
- Functional emoji được thay bằng Codicon khi có lựa chọn phù hợp. Donate story và pixel-art NPC được giữ expressive artwork vì đó là content, không phải control chrome.

### Ngôn ngữ bố cục

- Dense row tiếp tục dày; spacing tạo group nhưng không biến extension thành card dashboard.
- Toolbar wrap hoặc collapse có quy tắc ở narrow width.
- Table căn ổn định và chứa overflow đúng chỗ.
- Sticky header chỉ dùng khi zone tự scroll.
- Resizer có handle rõ, minimum width, persistence và keyboard alternative nếu webview host cho phép.
- Empty và error state nói rõ chuyện gì xảy ra và action hợp lệ tiếp theo.

### Ngôn ngữ tương tác

- Cùng action name xuất hiện trên button, notification, progress và completion message.
- Hover, focus, pressed, selected, disabled và loading state phải phân biệt được.
- Keyboard order đi theo visual order.
- Motion ngắn, có mục đích và giảm hoặc tắt qua `prefers-reduced-motion`.
- Mọi webview action tạo structured diagnostic log, không chỉ ghi console.

## Contract phân cấp công việc

Implementation plan và task list phải theo hierarchy:

1. version;
2. screen hoặc module;
3. zone;
4. atomic task cho icon, layout, interaction, state, refactor, test, documentation, mockup hoặc screenshot.

Task như “làm đẹp Search” hoặc “sửa icon” không hợp lệ vì không review và verify độc lập được.

Mỗi zone phải trả lời:

- Zone giúp người dùng làm gì?
- Icon và action nào thuộc zone?
- State nào sở hữu dữ liệu?
- Empty, loading, success, warning, error và disabled state là gì?
- Zone hoạt động ra sao ở narrow width?
- Zone dùng shared pattern nào?
- Mockup nào đã được duyệt?
- Test nào chứng minh hoạt động đúng?

## Phiên bản 1.0.6: Foundation và native sidebar

### Shared foundation

- định nghĩa A2 token và rule sử dụng;
- định nghĩa shared action name và semantic icon category;
- tạo đầy đủ icon audit artifact;
- thêm drift test cho command icon, menu placement và canonical inline slot;
- định nghĩa empty, loading, warning, error và status language dùng chung;
- định nghĩa responsive và accessibility check xuyên màn hình.

### Màn hình SSH Hosts

#### View title zone

- audit từng title icon, position, tooltip và enablement rule;
- group create, import, refresh và expand action nhất quán;
- giữ command và view identifier hiện có.

#### Host row zone

- căn endpoint, alias, connection state, credential state và inline action;
- phân biệt saved endpoint, active connection, failed connection và unavailable state không chỉ bằng màu;
- verify row identifier và expansion behavior ổn định.

#### Account và pinned-folder zone

- thống nhất person, key, folder, add và remove semantic;
- rút gọn description nhưng giữ connection detail;
- verify empty-account và empty-pinned-folder guidance.

### Màn hình Remote Files

#### View title zone

- audit navigation, refresh, search, filter, focus, expand và overflow action;
- giữ canonical inline icon slot và loại collision;
- làm active filter và navigation state dễ đọc.

#### Connection row zone

- căn connection identity, current path, filter summary, loading, disconnected và error state;
- giữ search và terminal action ở canonical slot.

#### Folder và file row zone

- audit file-type, folder, loading, upload, failure, filtered, open và dimmed icon/decoration;
- căn name, size, modified time, match count và inline action;
- giữ drag-and-drop, multi-select, filtering và smart reveal behavior.

#### Parent, empty, loading và error zone

- cho parent row vai trò navigation rõ;
- làm loading và failed-listing state có action;
- không để empty folder bị hiểu nhầm là failed folder.

### Màn hình Activity

- audit grouping, activity-type, status, cancel, clear và expand icon;
- căn running, completed, failed và cancelled row;
- làm trạng thái không có activity hữu ích và yên tĩnh;
- giữ grouping và cancellation behavior.

### Màn hình Port Forwards

- phân biệt active forward và saved inactive rule;
- căn local endpoint, remote endpoint, host identity, start, stop và remove action;
- làm empty và disconnected state rõ;
- giữ saved-rule restoration.

### Native dialog và feedback surface

- audit Quick Pick icon, label, description, separator và order;
- căn Input Box prompt, example, validation và action name;
- chuẩn hóa progress, status-bar, information, warning và error message;
- giữ confirmation và safety boundary cho destructive action.

### Mockup bắt buộc cho 1.0.6

- full sidebar ở light/dark theme;
- SSH Hosts với endpoint, connected, failed và empty state;
- Remote Files với default, filter, loading, upload failure và empty folder state;
- Activity với running, success, failed, cancelled và empty state;
- Port Forwards với active, saved inactive, disconnected và empty state;
- title toolbar và inline action ở normal, hover, selected và disabled; không cần mockup biến thể sidebar hẹp riêng;
- board đối chiếu mọi icon/slot giữa bốn tree module.
- parity board chứng minh số icon hiển thị theo từng toolbar, từng loại row và từng state bằng chính xác phiên bản 1.0.5.

## Phiên bản 1.0.7: Search module

### Refactor kiến trúc

- tách tab state, server-scope rendering, result rendering và interaction wiring thành unit rõ khi file hiện tại cản trở thay đổi an toàn;
- giữ message protocol hiện có trừ khi typed extension là bắt buộc;
- giữ progressive batch, kept search, cancellation, search identifier và result completeness;
- chuyển row và control lặp lại sang shared pattern.

### Query toolbar zone

- audit case-sensitive, whole-word, regular-expression, filename, index, search và cancel control;
- chuẩn hóa active, hover, focus, disabled, stale-index warning, searching và cancellation state;
- giữ Enter-key behavior và query state.

### Advanced pattern zone

- refactor disclosure state;
- căn include/exclude label, field, example, validation và narrow-width wrapping;
- giữ saved/restored state.

### Server scope zone

- redesign server row, connection state, selected state, path, add-folder action, worker description, redundant path và cross-account overlap warning;
- giữ all-server, no-server, sorting và auto-connect behavior;
- phân biệt unavailable server với unselected server.

### Split và resizer zone

- giữ split layout control bên trái và result bên phải;
- cải thiện handle, minimum width, persistence, pointer behavior và narrow-width fallback;
- thêm keyboard adjustment nếu webview host cho phép.

### Result tab và header zone

- căn kept-search tab, close action, result count, file count, progress, hit limit, view mode và expand control;
- xử lý tab overflow mà không ẩn active query;
- giữ independent active search.

### List và tree result zone

- thống nhất server, folder, file, match, line number, path, count, reveal, selected và hover presentation;
- giữ progressive rendering và large-result performance;
- làm empty, searching, partial, cancelled, complete, limit-reached và error state rõ.

### Mockup bắt buộc cho 1.0.7

- full Search ở light/dark theme và normal/narrow width;
- từng zone ở default, hover, focus, selected, disabled, searching, partial, complete, cancelled, empty và error state;
- list view và tree view;
- single server, many servers, redundant path, overlap warning, kept tabs và tab overflow;
- board đối chiếu Search với foundation 1.0.6.

## Phiên bản 1.0.8: Server Monitor module

### Refactor kiến trúc

- chuyển dashboard HTML, CSS và interaction code khỏi `ServerMonitorService.ts` sang monitor webview module riêng;
- giữ data collection và trusted command execution trong service;
- định nghĩa typed state/action message;
- giữ manual refresh, automatic refresh, pause, terminal và diagnostic behavior.

### Header và refresh zone

- audit monitor identity, host name, last-updated time, countdown, pause, resume, refresh và live-terminal control;
- căn refreshing, paused, disconnected và failed state.

### Metric zone

- làm load, memory, swap và connection value dễ quét;
- threshold presentation phải ghép text/icon với màu;
- không dùng màu trang trí tùy ý.

### Disk zone

- căn mount, size, used, free, percentage và progress;
- xử lý mount name dài và narrow width;
- phân biệt unavailable data với zero.

### Process zone

- căn row count, sort control, process identity, processor use, memory use và command detail;
- có overflow và sorting behavior ổn định;
- giữ complete process data trong configured limit.

### Loading và error zone

- dùng cùng shell/spacing với loaded screen;
- nói rõ operation thất bại và next action;
- giữ diagnostic log trong output channel SSH Lite.

### Mockup bắt buộc cho 1.0.8

- full Monitor ở light/dark theme và normal/narrow width;
- normal, high-load, high-memory, disk-warning, paused, refreshing, disconnected, loading và error state;
- process table với short/long command và overflow;
- board đối chiếu header, toolbar, table, status và feedback với Search.

## Phiên bản 1.0.9: Connection Import và Donate

### Connection Import refactor

- chuyển inline HTML, CSS và interaction code sang import webview module riêng;
- giữ trusted import selection và extension-side validation;
- định nghĩa typed message cho selection, import, cancel và logging.

### Connection Import zone

- header/summary: giải thích source, row count, conflict và decision model;
- bulk toolbar: căn keep-current, use-file và selected count;
- comparison row: căn current/incoming column, radio choice, changed field, key, credential và pinned-folder badge;
- empty-current side: nói rõ connection mới;
- footer: giữ cancel/import action luôn thấy và ổn định;
- narrow width: stack hai side mà vẫn rõ source.

### Donate refactor

- chuyển inline presentation sang donate webview module riêng;
- giữ trusted address lookup và clipboard validation;
- dùng shared A2 pattern nhưng giữ cá tính Bánh Mì Việt Nam.

### Donate zone

- story/animation: progress dễ hiểu và tôn trọng reduced motion;
- donation card: căn network, chain, note, Quick Response (QR) code, address và copy action;
- feedback: dùng cùng action name từ button đến completion message;
- narrow width: address dễ đọc và QR code dùng được.

### Mockup bắt buộc cho 1.0.9

- Import với new-only, conflict, mixed, long value, no-selection và narrow-width state;
- Donate với loading story, revealed card, copied feedback, light/dark và narrow width;
- board đối chiếu form row, card, footer, button và feedback với foundation.

## Phiên bản 1.0.10: Support, NPC và global audit

### Support refactor

- chia controller lớn thành state, animation, banner, settings, hooks, zoom và action unit khi phù hợp;
- giữ pixel coder, user activity reaction, Artificial Intelligence (AI) activity reaction và local-only privacy contract;
- tách canvas art generation khỏi control layout.

### NPC canvas zone

- giữ crisp pixel scaling và interactive recoloring;
- verify user label, AI label, key popup, banner placement, resize và cleanup;
- reduced motion không được loại essential state.

### Zoom và settings zone

- audit zoom out, fit, zoom in, settings, checkbox, banner text, banner mode, setup hooks và remove hooks control;
- căn label, description, disabled, success, error state và narrow-width wrapping;
- giữ local-only privacy explanation.

### Support action zone

- căn report, donate, star, rate và share action;
- dùng icon và verb nhất quán;
- giữ external-link validation và command hiện có.

### Global consistency audit

- so sánh chín module theo token, icon, zone, responsive, copy, accessibility, motion và logging contract;
- giải quyết mọi icon-audit row còn lại;
- chạy light/dark, narrow, keyboard và reduced-motion check;
- chỉ cập nhật screenshot và user-facing documentation sau khi visual được duyệt.

### Mockup bắt buộc cho 1.0.10

- Support/NPC ở light/dark, narrow/normal, idle, typing, AI-active, settings-open, hook-success và hook-error state;
- motion storyboard và reduced-motion alternative;
- board cuối đặt cả chín module cạnh nhau;
- board icon semantic cuối cho toàn bộ 117 command.

## Tính toàn vẹn dữ liệu và tương thích ngược

Redesign phải giữ:

- command identifier;
- view identifier;
- setting key và default;
- connection và credential format;
- keybinding;
- context value trừ khi có migration;
- search completeness và cancellation guarantee;
- tree expansion, filtering, drag-and-drop và reveal behavior;
- monitor data và refresh semantic;
- import selection meaning;
- donation address validation;
- Support/NPC privacy behavior.

Không thêm automatic remote command, polling mặc định, preload, data truncation hoặc remote server dependency.

## Error handling và diagnostic

Mỗi module refactor phải định nghĩa explicit empty, loading, success, warning, error, disconnected, cancelled và disabled state phù hợp.

Webview gửi structured log message cho extension. Extension forward qua `infoLog` hoặc `diagLog`. Không thêm output channel thứ hai và không phụ thuộc developer tools console.

Error phải nói:

1. operation nào thất bại;
2. server, path hoặc item bị ảnh hưởng khi an toàn để hiển thị;
3. dữ liệu có thể partial hay không;
4. next action hợp lệ.

## Chiến lược verify

Mỗi release gồm:

- mockup được người dùng duyệt;
- focused unit test cho state/render logic được tách;
- user-interface test cho icon, state và interaction contract;
- manifest test cho contributed icon, menu, group và canonical inline slot;
- regression suite hiện có cho behavior bị ảnh hưởng;
- TypeScript compile sau mọi source change;
- toàn bộ Jest unit suite trước completion;
- real local SSH hoặc File Transfer Protocol (FTP) integration test khi behavior đi qua connection hoặc file-operation path;
- visual check ở light/dark theme;
- responsive check ở normal/narrow width;
- keyboard và visible-focus check;
- reduced-motion check;
- screenshot comparison cho mỗi screen redesign;
- documentation và chaos-catalog regeneration khi command hoặc flow thay đổi.

## Release acceptance gate

Release chỉ hoàn thành khi:

1. mọi mockup bắt buộc đã được người dùng duyệt;
2. mọi screen và zone có atomic task hoàn thành;
3. mọi icon audit row bị ảnh hưởng có final decision và verification evidence;
4. cross-screen token và pattern check pass;
5. command location và workflow quen thuộc được giữ, trừ thay đổi đã duyệt rõ;
6. compile và relevant test pass;
7. visual inspection pass ở light, dark, normal và narrow state;
8. accessibility và reduced-motion check pass;
9. diagnostic log tới output channel SSH Lite;
10. documentation và release note khớp giao diện ship.

## Ngoài phạm vi

- Search workflow nhiều bước đã bị từ chối;
- framework migration;
- design system tách khỏi VS Code;
- feature removal hoặc command consolidation chỉ để giảm visual density;
- bật remote polling mặc định;
- service hoặc connection refactor không liên quan;
- phát hành mọi screen redesign trong cùng một version;
- tự implement thay đổi visual chưa có mockup được người dùng duyệt.
