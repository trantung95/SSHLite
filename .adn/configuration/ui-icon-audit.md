# Kiểm tra ngôn ngữ icon SSH Lite

- **Ngày kiểm tra:** 2026-08-10
- **Phiên bản sản phẩm:** 1.0.5
- **Phiên bản Visual Studio Code tối thiểu:** 1.85.0
- **Phạm vi:** 117 command icon và các ThemeIcon trong bốn native tree module
- **Trạng thái:** đã triển khai; regression gate kiểm tra manifest ở cấp Visual Studio Code tối thiểu

## Nguồn chuẩn

Việc chọn icon dựa trên ba nguồn chính thức:

1. [Product Icon Reference của Visual Studio Code](https://code.visualstudio.com/api/references/icons-in-labels) xác nhận extension nên dùng Codicon và ThemeIcon để icon đi theo product icon theme của người dùng.
2. [Codicon catalog chính thức](https://microsoft.github.io/vscode-codicons/dist/codicon.html) cung cấp tên và nghĩa hiện tại của từng icon.
3. [Fluent 2 Iconography](https://fluent2.microsoft.design/iconography) yêu cầu icon phải quen thuộc, dễ nhận ra, có mục đích ngữ nghĩa; màu chỉ dùng tiết chế và không thay thế label.

Danh sách icon còn được đối chiếu với [source Visual Studio Code 1.85.2](https://github.com/microsoft/vscode/blob/1.85.2/src/vs/base/common/codicons.ts), vì catalog mới nhất có icon mà phiên bản tối thiểu của SSH Lite chưa hỗ trợ.

## Nguyên tắc quyết định

1. Icon mô tả hành động hoặc đối tượng chính, không mô tả chi tiết phụ.
2. Cùng hành động dùng cùng icon ở mọi màn hình và mọi menu.
3. Hai action đứng cạnh nhau không được dùng cùng glyph nếu chức năng khác nhau; tooltip không đủ để sửa một toolbar khó phân biệt bằng mắt.
4. `filter` hình phễu dùng thống nhất cho mọi thao tác lọc tệp hoặc tên tệp.
5. `search` dành cho “Tìm kiếm nâng cao”; `remote-explorer` dành cho “Quét sâu theo bộ lọc” để hai action khác nhau cả glyph lẫn tooltip.
6. `expand-all`, `fold-down`, `collapse-all` biểu thị đúng action kế tiếp theo trạng thái cây; không dùng icon gộp “mở rộng hoặc thu gọn”.
7. `trash` chỉ dùng khi dữ liệu thật sự bị xóa; `close` hoặc `clear-all` dùng cho đóng, bỏ lọc hoặc dọn danh sách.
8. `add` dùng để tạo đối tượng; trạng thái active không dùng cùng ngôn ngữ với thao tác tạo.
9. Không dùng icon dành riêng cho debugger, máy ảo hoặc cloud nếu ngữ cảnh thực tế rộng hơn.
10. Mọi icon phải tồn tại từ Visual Studio Code 1.85.2; không dựa riêng vào catalog mới nhất.
11. Màu chỉ bổ sung nghĩa. Trạng thái vẫn phải có label, description hoặc tooltip.
12. Tooltip của action dễ nhầm phải nói rõ đối tượng tìm, phạm vi thực thi và nơi hiển thị kết quả; không chỉ lặp lại command title.

## Kết quả command icon

- 117 command đã được kiểm tra.
- 66 Codicon khác nhau đang được dùng.
- 104 command giữ nguyên icon.
- 13 command đã đổi icon.
- `$(import)` là icon duy nhất trước thay đổi không tồn tại trong Visual Studio Code 1.85.2.

### 13 thay đổi đã triển khai

| Command | Trước thay đổi | Đã triển khai | Lý do |
|---|---|---|---|
| `sshLite.importConnections` | `import` | `arrow-circle-down` | `import` không có trong Visual Studio Code 1.85.2; mũi tên đi vào là ẩn dụ import quen thuộc và tương thích. |
| `sshLite.forwardPort` | `arrow-right` | `add` | Đây là thao tác tạo port forward. Visual Studio Code cũng dùng dấu cộng cho hành động forward port. |
| `sshLite.cancelSearch` | `stop` | `search-stop` | Giữ cả đối tượng search và hành động dừng, dễ phân biệt với dừng transfer hoặc activity. |
| `sshLite.cutRemoteItem` | `files` | `move` | `files` chỉ biểu thị nhiều tệp, không biểu thị cut. Codicon 1.85 không có scissors; `move` phản ánh kết quả cuối của cut rồi paste. |
| `sshLite.manageSnippets` | `list-tree` | `symbol-snippet` | `list-tree` mô tả bố cục, không mô tả snippet. |
| `sshLite.pushPubKeyToHost` | `cloud-upload` | `key` | Đối tượng quan trọng là SSH public key; máy chủ SSH không mặc định là cloud. |
| `sshLite.diagnoseSlowness` | `bug` | `pulse` | Chẩn đoán hiệu năng là kiểm tra sức khỏe, không mặc định là báo lỗi phần mềm. |
| `sshLite.pinFolder` | `pinned` | `pin` | `pin` là hành động; `pinned` là trạng thái sau hành động. |
| `sshLite.deletePinnedFolder` | `trash` | `close` | Command chỉ bỏ liên kết pinned folder, không xóa thư mục remote; thùng rác gây sợ xóa dữ liệu. |
| `sshLite.clearAuditLog` | `trash` | `clear-all` | Đây là thao tác dọn nội dung log; khớp ngôn ngữ clear của Visual Studio Code. |
| `sshLite.showBackupLogs` | `list-flat` | `output` | Màn hình hiển thị log/output, không phải đổi kiểu tree thành danh sách phẳng. |
| `sshLite.showServerBackups` | `server` | `archive` | Đối tượng đang mở là bộ backup; phạm vi server đã có trong row và label. |
| `sshLite.manageRemoteService` | `server-environment` | `gear` | Service management là cấu hình/vận hành; `server-environment` dễ bị hiểu thành biến môi trường. |

### Những lựa chọn dễ gây tranh luận nhưng giữ nguyên

| Nhóm | Quyết định | Giải thích |
|---|---|---|
| Rename dùng `edit` | Giữ | Catalog mới có `rename`, nhưng Visual Studio Code 1.85.2 chưa có. `edit` vẫn là ẩn dụ bút chì quen thuộc. |
| Connect dùng `plug` | Giữ | Plug là ẩn dụ kết nối phổ biến và có sẵn ở phiên bản tối thiểu. |
| Disconnect dùng `debug-disconnect` | Giữ tạm | Hình glyph thể hiện ngắt kết nối rõ và đã quen trong Visual Studio Code; chưa có Codicon disconnect trung tính tốt hơn ở 1.85.2. |
| Upload/download dùng `cloud-upload` và `cloud-download` | Giữ | Trong ngữ cảnh hàng tệp remote, hướng truyền là nghĩa chính và tooltip làm rõ đích SSH hoặc File Transfer Protocol (FTP). |
| Filter clear dùng `close` | Giữ | Dấu nhân là cách phổ biến để xóa nội dung filter mà không ám chỉ xóa dữ liệu. |
| Delete dữ liệu dùng `trash` | Giữ | Host lưu, credential, saved forward, temp file và backup thật sự bị xóa. |
| Cancel activity dùng `stop`; cancel all dùng `stop-circle` | Giữ | Cùng họ nghĩa nhưng đủ phân biệt phạm vi một item và toàn bộ. |
| “Tìm kiếm nâng cao” dùng `search`; “Quét sâu theo bộ lọc” dùng `remote-explorer` | Giữ | Hai action khác nhau đứng cạnh nhau phải khác cả glyph lẫn tooltip; tên mới nói rõ một bên mở màn hình tìm kiếm đầy đủ, một bên quét tên tệp theo bộ lọc hiện tại. |
| Lọc tệp dùng `filter` | Giữ | Phễu là hình lọc quen thuộc và là Codicon Visual Studio Code dùng cho filter. |
| Mở rộng/thu gọn cây dùng `expand-all`, `fold-down`, `collapse-all` | Giữ | Icon đổi theo action kế tiếp của trạng thái hiện tại; không dùng một glyph gộp mơ hồ. |

## Cổng chống tái phát

1. `src/__tests__/ui-manifest-contract.test.ts` đọc đủ 117 command và chỉ chấp nhận 66 Codicon đã xác nhận tồn tại trong Visual Studio Code 1.85.2. Test cũng khóa 13 icon đã đổi để tránh thay đổi nghĩa action ngoài ý muốn.
2. `src/__tests__/ftp-menu-gating.test.ts` chặn collision `inline@N` trên từng Remote Files row và xác nhận các action dùng chung luôn giữ slot canonical: search `@1`, filter `@2`, terminal `@3`, refresh `@4`.
3. Các entry context-menu overflow như `1_actions@N` không phải inline slot. Chúng không làm thay đổi số lượng hoặc thứ tự icon hiển thị trên row.

## Kết quả ThemeIcon trong native tree

| Module và zone | Trước thay đổi | Đã triển khai | Lý do |
|---|---|---|---|
| SSH Hosts · host row | `vm`, `vm-running`, `vm-outline` | `server` với màu và description theo trạng thái | Secure Shell (SSH) host có thể là máy vật lý, container, router hoặc máy ảo; `vm` quá hẹp. |
| Remote Files · connection root | custom VM icon hoặc `vm-active` | `remote` | Row đại diện kết nối remote, không phải loại máy. |
| Remote Files · file đang mở | `eye` màu xanh | giữ file icon; thêm description hoặc decoration “đang mở” | Eye thường có nghĩa show/hide hoặc preview; thay file icon bằng eye làm mất loại đối tượng. |
| Remote Files · parent folder | `arrow-up` màu vàng | `arrow-up` theo foreground mặc định | Màu amber dành cho nhận diện SSH; điều hướng parent không phải warning hoặc brand state. |
| SSH Hosts · protocol group | `terminal` cho SSH, `cloud` cho FTP | `remote` cho cả hai; label và description phân biệt protocol | FTP không đồng nghĩa cloud; icon chung thể hiện remote connection trung thực hơn. |
| Activity · status rows | `sync~spin`, `check`, `circle-slash`, `error` | Giữ | Khớp loading, success, cancelled và error phổ biến; có description đi kèm. |
| Port Forwards · rule rows | `arrow-swap` active/disabled | Giữ | Hai chiều truyền là ẩn dụ phù hợp cho port forwarding; màu chỉ bổ sung active state. |

## Quy tắc slot và màu

- Search/filter đứng trước action đặc thù của row.
- Open, terminal, refresh, disconnect và monitor giữ đúng slot canonical trong `AGENTS.md`.
- Row thiếu action không được kéo icon phía sau sang slot trước.
- Không tăng hoặc giảm số action icon đang hiển thị trên toolbar, row hoặc state so với cùng ngữ cảnh trong phiên bản 1.0.5. Có thể đổi icon và thứ tự để action cùng nghĩa dùng cùng slot xuyên module; không được lấy tính nhất quán làm lý do thêm action mới hoặc giấu action đang hiện vào overflow.
- Amber chỉ dùng cho nhận diện SSH hoặc ngữ cảnh đặc biệt đã có label; không dùng cho parent navigation.
- Green, yellow và red phải đi cùng text hoặc tooltip tương ứng active, warning và error.
- Destructive action chỉ dùng red khi hành động có thể làm mất dữ liệu; không tô red cho unpin, close hoặc clear filter.

## Kiểm chứng bắt buộc khi implement

1. Thêm test đọc toàn bộ `contributes.commands` và xác nhận icon identifier tồn tại trong catalog tương thích với Visual Studio Code tối thiểu.
2. Thêm test cố định mapping cho 13 command thay đổi để tránh icon drift.
3. Kiểm tra mọi `view/title` và `view/item/context` để một command dùng cùng icon và đúng inline slot ở mọi row.
4. Kiểm tra thủ công dark theme, light theme, hover, selected, disabled, loading, warning và error.
5. Kiểm tra tooltip và label bằng tiếng Anh trong sản phẩm rõ nghĩa ngay cả khi icon bị product icon theme thay đổi.
6. Không nâng phiên bản Visual Studio Code tối thiểu chỉ để lấy icon mới.
