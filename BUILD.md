# Hướng dẫn Build MyHackMD thành file .exe

## Yêu cầu
- Node.js (phiên bản 14 trở lên)
- npm hoặc yarn

## Các bước build

### 1. Cài đặt dependencies
```bash
npm install
```

### 2. Build file .exe và chuẩn bị phân phối
```bash
npm run build
```

Script build sẽ:
- Tự động cài đặt `pkg` nếu chưa có
- Build file `MyHackMd.exe` 
- Copy file .exe và thư mục `public/` vào thư mục `dist/`
- Tạo file `README.txt` hướng dẫn sử dụng

Sau khi build xong, tất cả file cần thiết sẽ nằm trong thư mục `dist/`.

### 3. Chạy file .exe
Double-click vào file `MyHackMd.exe` trong thư mục `dist/` để chạy. Ứng dụng sẽ:
- ✅ Tự động khởi động web server
- ✅ Tự động mở trình duyệt với địa chỉ `http://localhost:3000`
- ✅ Hiển thị thông tin server trong console:
  ```
  ============================================================
  🚀 MyHackMD Server is running!
  📝 Web Interface: http://localhost:3000
  📁 Files stored in: [đường dẫn thư mục bin]
  ============================================================
  ```

## Cấu trúc sau khi build

```
dist/
├── MyHackMd.exe    # File chạy chính
├── public/         # Thư mục giao diện (HTML, CSS, JS)
│   ├── index.html
│   ├── style.css
│   └── script.js
└── README.txt      # Hướng dẫn sử dụng
```

## Lưu ý
- Khi chạy từ .exe, thư mục `public/` **phải** nằm cùng thư mục với file .exe
- Thư mục `bin/` sẽ được tạo tự động khi chạy lần đầu (nằm cùng thư mục với .exe)
- Để dừng server, đóng cửa sổ console hoặc nhấn `Ctrl+C`

## Phân phối
Để phân phối ứng dụng:
1. Nén toàn bộ nội dung trong thư mục `dist/` thành file ZIP
2. Người dùng chỉ cần giải nén và chạy `MyHackMd.exe`
3. Không cần cài đặt Node.js hay bất kỳ phần mềm nào khác

## Troubleshooting

### Lỗi "Cannot find module"
- Đảm bảo thư mục `public/` nằm cùng thư mục với `MyHackMd.exe`

### Port 3000 đã được sử dụng
- Đóng các ứng dụng khác đang dùng port 3000
- Hoặc sửa PORT trong `server.js` trước khi build

### Browser không tự động mở
- Mở trình duyệt thủ công và truy cập `http://localhost:3000`

