// 比對完整的虛構會員資料，不把耗時或隨機 ID 中的四位數當成個資。
export const privateFixtureMarkers = /PRIVATE_INFORMATION_MARKER|PRIVATE_DIALOG|PRIVATE_PASSWORD|0987\*\*\*654/;
