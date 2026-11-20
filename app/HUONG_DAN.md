# Gala Spin — mở là chạy, không cần Python

## Bắt đầu
1. Giải nén toàn bộ dự án. Giữ `index.html` cạnh thư mục `app`.
2. Nhấp đúp `index.html`, mở bằng **Chrome hoặc Edge desktop mới**.
3. Bấm **Chọn thư mục & bắt đầu**, chọn thư mục `app`, cho phép đọc/ghi.
4. Bấm ⚙ → đặt tên đợt → nhập Excel `.xlsx` hoặc CSV UTF-8.
5. Thiết lập giải, tiêu đề, màu/ảnh nền → Lưu → đóng thiết lập → quay.

**Không cần cài Python, Node.js, không chạy terminal, không có server.** Không cần Internet khi sử dụng.

Có thể chọn thư mục trống khác. Ứng dụng nhớ thư mục bằng IndexedDB trên cùng trình duyệt và địa chỉ trang. Lần mở lại còn quyền thì tự vào; nếu cần cấp lại quyền, bấm “Cho phép dùng lại thư mục”. Có thể bấm “Chọn thư mục khác” khi thư mục cũ không còn dùng. Nếu trình duyệt chặn lưu tham chiếu hoặc bạn xóa dữ liệu trình duyệt, chọn lại đúng thư mục đã dùng. Không chọn thư mục gốc ổ đĩa hay thư mục hệ thống bị trình duyệt chặn. Nếu hủy/chưa cấp quyền, bấm chọn lại; ứng dụng không quay khi chưa mở được dữ liệu.

## Thao tác sân khấu
- **SPACE**: quay; nếu đang hiện người trúng thì chỉ đóng kết quả.
- **V**: đánh dấu vắng mặt và đóng kết quả. Người vắng vẫn bị loại khỏi đợt đó.
- **F** hoặc nút ⛶: toàn màn hình.
- Dùng ⚙ để nhập nhiều đợt và chọn đợt; mỗi đợt có giải và diện mạo riêng.
- Tải Excel mẫu trong Thiết lập. Thứ tự cột mẫu: **Mã nhân viên → Tên nhân viên → Email công ty → Phòng ban**. Định dạng mã nhân viên dạng văn bản để giữ số 0 đầu. File cũ dùng `email`, `name`, `department` vẫn nhập được; mã nhân viên để trống nếu chưa có.
- Chỉ đọc sheet đầu tiên, không chạy macro/công thức. File `.xls` cũ không được hỗ trợ; lưu thành `.xlsx` hoặc CSV UTF-8.
- Bấm xuất Excel để lưu báo cáo vào thư mục đợt và tải thêm bản sao.

## Dữ liệu và an toàn
Bên trong **thư mục đã chọn**:
- `src/setting/<mã đợt>.json`: cấu hình.
- `src/data/yyyy_MM_dd_randchar[8]/people.json`: nhân sự, ví dụ `src/data/2026_11_19_a1b2c3d4/people.json`. Ngày, tháng, năm nằm trong cùng tên thư mục, không chia cấp.
- `src/data/.../events.jsonl`: log trúng/vắng, lưu trước khi chạy hiệu ứng.
- `src/data/.../original.xlsx` hoặc `.csv`: file đầu vào.
- `src/images/`: ảnh nền.

Chọn thư mục `app` cũ để đọc dữ liệu của bản Python; không cần chuyển đổi thủ công. Sao lưu **toàn bộ thư mục đã chọn** khi đã dừng quay/đóng trang, không chỉ file Excel kết quả.

Chỉ dùng **một tab, một máy, một người điều khiển** cho mỗi thư mục. Không chỉnh tay JSON/log khi ứng dụng mở. Không đặt trên ổ mạng, USB chập chờn hoặc thư mục đang đồng bộ. Trình duyệt có thể hỏi lại quyền sau khi đóng/mở trang; đó là cơ chế bảo vệ, không phải thiếu phần mềm.

Nếu lỗi ghi log: không chuyển đợt, không xóa dữ liệu; khôi phục quyền/ổ đĩa và nhấn quay lại để khôi phục cùng lượt. Khi tải lại giữa lượt, chọn đúng thư mục, đúng đợt rồi quay lại. Dữ liệu log hỏng làm ứng dụng dừng, không tự xóa người trúng.

## Kiểm tra trước gala
Thử trên **đúng máy Windows/Ubuntu và màn hình sân khấu**: chọn thư mục, nhập thử, quay, đánh dấu vắng, tải lại, xuất Excel, đóng/mở lại. Thử riêng trên thư mục kiểm tra, không xóa log đợt thật.

Firefox/Safari và trình xem HTML nhúng không phải mục tiêu hỗ trợ của phiên bản này. Chrome/Edge có chính sách doanh nghiệp chặn quyền file cần quản trị viên cho phép. Không có nút nào trong trang tự cài phần mềm hay tự mở shell.
