"use client";

import { useState } from "react";
import { Header } from "@/components/Header";
import { Hero } from "@/components/Hero";
import { Identification } from "@/components/Identification";
import { Shift } from "@/components/Shift";
import { Access } from "@/components/Access";
import { HowItWorks } from "@/components/HowItWorks";
import { Desire } from "@/components/Desire";
import { Cost } from "@/components/Cost";
import { Faq } from "@/components/Faq";
import { Footer } from "@/components/Footer";
import { Quiz, type QuizAnswers } from "@/components/Quiz";
import { CaptureForm } from "@/components/CaptureForm";
import { Success } from "@/components/Success";

type Stage = "idle" | "quiz" | "capture" | "success";

export default function Home() {
  const [stage, setStage] = useState<Stage>("idle");
  const [answers, setAnswers] = useState<QuizAnswers>({});
  const [name, setName] = useState("");

  const startQuiz = () => setStage("quiz");

  return (
    <main className="relative">
      <Header onCta={startQuiz} />

      <Hero onCta={startQuiz} />
      <Identification />
      <Shift />
      <Access />
      <HowItWorks onCta={startQuiz} />
      <Desire />
      <Cost onCta={startQuiz} />
      <Faq />
      <Footer />

      <Quiz
        open={stage === "quiz"}
        onClose={() => setStage("idle")}
        onComplete={(a) => {
          setAnswers(a);
          setStage("capture");
        }}
      />

      <CaptureForm
        open={stage === "capture"}
        onClose={() => setStage("idle")}
        answers={answers}
        onSuccess={(n) => {
          setName(n);
          setStage("success");
        }}
      />

      <Success
        open={stage === "success"}
        onClose={() => setStage("idle")}
        name={name}
      />
    </main>
  );
}
