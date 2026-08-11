import type { Metadata } from "next";
import { SubtitleStudio } from "./SubtitleStudio";

export const metadata: Metadata = {
  title: "自学型熟肉机",
  description: "先自学作品背景，再完成精准翻译、字幕精修与封装。",
};

export default function Home() {
  return <SubtitleStudio />;
}
