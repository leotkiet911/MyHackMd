# Hướng dẫn Build và Chạy MyHackMD

## Bước 1: Cài đặt Dependencies

```bash
npm install
```

Lệnh này sẽ cài đặt tất cả các dependencies cần thiết, bao gồm:
- express
- body-parser
- socket.io
- pkg (dev dependency)

## Bước 2: Build file .exe

```bash
npm run build
```

Lệnh này sẽ:
1. Kiểm tra và cài đặt `pkg` nếu chưa có
2. Build file `MyHackMd.exe` trong thư mục gốc
3. Bundle tất cả dependencies và assets vào .exe

## Bước 3: Chạy file .exe

Sau khi build xong, bạn sẽ thấy file `MyHackMd.exe` trong thư mục gốc.

**Cách chạy:**
1. Double-click vào file `MyHackMd.exe`
2. Hoặc chạy từ command line: `.\MyHackMd.exe`

## Khi chạy .exe, bạn sẽ thấy:

```
============================================================
🚀 MyHackMD Server is running!
📝 Local Interface: http://localhost:3000
🌐 LAN Interface: http://192.168.x.x:3000
📁 Files stored in: [đường dẫn thư mục bin]
📡 Realtime sync: Enabled (Socket.IO)
============================================================

💡 Other devices on your network can access:
   http://192.168.x.x:3000
```

## Lưu ý quan trọng:

1. **Thư mục `bin/`**: Sẽ được tạo tự động khi chạy lần đầu để lưu các file .md

2. **Thư mục `public/`**: 
   - Nếu chạy từ .exe, thư mục `public/` sẽ được extract tự động từ bundled assets
   - Hoặc bạn có thể copy thư mục `public/` vào cùng thư mục với .exe

3. **Realtime Sync**: 
   - Socket.IO đã được bundle vào .exe
   - Các máy khác trong LAN có thể truy cập và đồng bộ realtime

4. **Port 3000**: 
   - Đảm bảo port 3000 không bị sử dụng bởi ứng dụng khác
   - Nếu bị chiếm, sửa PORT trong `server.js` trước khi build

## Troubleshooting:

### Lỗi "Cannot find module"
- Đảm bảo đã chạy `npm install` trước khi build
- Thử build lại: `npm run build`

### Lỗi "Port 3000 already in use"
- Đóng các ứng dụng khác đang dùng port 3000
- Hoặc sửa PORT trong `server.js` trước khi build

### Socket.IO không hoạt động
- Kiểm tra firewall có chặn port 3000 không
- Đảm bảo các máy trong cùng mạng LAN

### File .exe không chạy được
- Kiểm tra Windows Defender/Antivirus có chặn không
- Thử chạy với quyền Administrator
- Kiểm tra console để xem lỗi cụ thể

## Phân phối:

Để phân phối ứng dụng:
1. File `MyHackMd.exe` (đã bao gồm tất cả dependencies)
2. Thư mục `public/` (sẽ được extract tự động, hoặc copy thủ công)
3. Thư mục `bin/` (sẽ được tạo tự động khi chạy)

Người dùng chỉ cần:
- Double-click `MyHackMd.exe`
- Không cần cài đặt Node.js hay bất kỳ phần mềm nào khác!

